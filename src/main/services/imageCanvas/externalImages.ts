import { randomInt } from 'node:crypto'

import type {
  ImageCanvasModel,
  ImageCanvasProgress,
  ImageCanvasProvider,
  ImageCanvasRequest
} from '@shared/config/imageCanvas'
import { dashscopeFixedSizes, dashscopeImageProfile } from '@shared/config/imageCapabilities'
import sharp from 'sharp'

import {
  decodeImage,
  imageCanvasTimeout,
  imageEndpoint,
  type ImageFetch,
  limitedBytes,
  resolveImageResults
} from './protocol'
import type { CanvasRemoteJob } from './studio'

type Json = Record<string, any>
const remoteId = /^[A-Za-z0-9_-]{1,128}$/

function headersFor(provider: ImageCanvasProvider): Headers {
  const headers = new Headers(provider.headers)
  headers.delete('host')
  headers.delete('content-length')
  headers.delete('content-type')
  const key = provider.apiKey
    .split(/(?<!\\),|\r?\n/)
    .map((value) => value.trim().replace(/\\,/g, ','))
    .find(Boolean)
  if (key) headers.set('Authorization', `Bearer ${key}`)
  return headers
}

async function jsonRequest(
  provider: ImageCanvasProvider,
  protocol: string,
  path: string,
  request: ImageFetch,
  body?: unknown,
  asyncTask = false
): Promise<Json> {
  const headers = headersFor(provider)
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  if (asyncTask) headers.set('X-DashScope-Async', 'enable')
  const response = await request(imageEndpoint(provider.apiHost, protocol, path), {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(body === undefined ? 60000 : imageCanvasTimeout)
  })
  if (!response.ok) throw new Error(`upstream_http_${response.status}`)
  try {
    return JSON.parse(new TextDecoder().decode(await limitedBytes(response, 115 * 1024 * 1024)))
  } catch {
    throw new Error('invalid_result_image')
  }
}

function openAIResults(payload: Json): string[] {
  if (!Array.isArray(payload.data)) return []
  return payload.data
    .map((item: Json) => (item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url))
    .filter(Boolean)
}

function chatResults(payload: Json): string[] {
  const result: string[] = []
  for (const choice of payload.choices || []) {
    const message = choice.message || {}
    for (const image of message.images || []) {
      const url = image.image_url?.url
      if (typeof url === 'string') result.push(url)
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        const url = part.type === 'image_url' ? part.image_url?.url : part.type === 'image' ? part.image : undefined
        if (typeof url === 'string') result.push(url)
      }
    } else if (typeof message.content === 'string') {
      // Only explicit Markdown images, never arbitrary links in assistant text.
      for (const match of message.content.matchAll(
        /!\[[^\]]*\]\((data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+|https:\/\/[^\s)]+)\)/g
      ))
        result.push(match[1])
    }
  }
  return [...new Set(result)]
}

async function finish(
  provider: ImageCanvasProvider,
  input: ImageCanvasRequest,
  values: string[],
  request: ImageFetch,
  accepted: (remote: CanvasRemoteJob) => void,
  progress: ImageCanvasProgress
): Promise<Buffer[]> {
  if (values.length && values.every((value) => typeof value === 'string' && value.startsWith('https:')))
    accepted({ origin: provider.apiHost, submissionId: input.id, kind: 'results', results: values })
  return resolveImageResults(values, request, progress)
}

export async function generateExternalImages(
  provider: ImageCanvasProvider,
  model: ImageCanvasModel,
  input: ImageCanvasRequest,
  request: ImageFetch,
  accepted: (remote: CanvasRemoteJob) => void,
  progress: ImageCanvasProgress
): Promise<Buffer[]> {
  progress('generating')
  if (model.protocol === 'openai-json') {
    const imageField = model.configuration?.imageField || 'images'
    const body: Json = { model: model.id, prompt: input.prompt, n: input.count }
    if (input.size !== 'auto') body.size = input.size
    if (input.quality && input.quality !== 'auto') body.quality = input.quality
    if (input.background && input.background !== 'auto') body.background = input.background
    if (input.references.length)
      body[imageField] =
        imageField === 'images' ? input.references.map((image_url) => ({ image_url })) : input.references
    if (input.mask) body.mask = imageField === 'images' ? { image_url: input.mask } : input.mask
    const payload = await jsonRequest(
      provider,
      model.protocol,
      input.references.length ? '/images/edits' : '/images/generations',
      request,
      body
    )
    return finish(provider, input, openAIResults(payload), request, accepted, progress)
  }
  if (model.protocol === 'chat') {
    const payload = await jsonRequest(provider, model.protocol, '/chat/completions', request, {
      model: model.id,
      stream: false,
      modalities: ['text', 'image'],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: input.prompt },
            ...input.references.map((url) => ({ type: 'image_url', image_url: { url } }))
          ]
        }
      ],
      ...(input.aspectRatio && input.aspectRatio !== 'auto'
        ? { image_config: { aspect_ratio: input.aspectRatio } }
        : {})
    })
    return finish(provider, input, chatResults(payload), request, accepted, progress)
  }
  if (model.protocol === 'dashscope') {
    const profile = dashscopeImageProfile(model.id)
    if (!profile) throw new Error('dashscope_model_unsupported')
    const editing = profile === 'wan-edit'
    const qwen = profile.startsWith('qwen-')
    if (
      (input.mask && !editing) ||
      (editing && input.references.length !== 1) ||
      (qwen && input.references.length > 3) ||
      (profile === 'qwen-fixed' && input.references.length) ||
      (['qwen-edit', 'qwen-edit-auto'].includes(profile) && !input.references.length) ||
      (!editing && !qwen && input.references.length)
    )
      throw new Error('image_reference_or_count_unsupported')
    const promptLimit = qwen ? 32000 : /^wan2\.5/i.test(model.id) ? 2000 : 500
    if ([...input.prompt].length > promptLimit) throw new Error('invalid_request')
    if (input.references.some((image) => decodeImage(image).bytes.length > 10 * 1024 * 1024))
      throw new Error('references_too_large')
    if (editing) {
      const meta = await sharp(decodeImage(input.references[0]).bytes).metadata()
      if (
        !meta.width ||
        !meta.height ||
        meta.width < 512 ||
        meta.height < 512 ||
        meta.width > 4096 ||
        meta.height > 4096
      )
        throw new Error('image_dimensions_unsupported')
      if (input.size !== 'auto' && input.size !== `${meta.width}x${meta.height}`)
        throw new Error('image_dimensions_unsupported')
    } else if (input.size !== 'auto') {
      const [width, height] = input.size.split('x').map(Number)
      const area = width * height
      const valid =
        profile === 'qwen-fixed'
          ? dashscopeFixedSizes.includes(input.size)
          : profile === 'qwen-edit-auto'
            ? false
            : profile === 'qwen-edit'
              ? width >= 512 && height >= 512 && width <= 2048 && height <= 2048
              : qwen
                ? area >= 512 ** 2 && area <= 2048 ** 2 && width / height >= 0.125 && width / height <= 8
                : /^wan2\.5/i.test(model.id)
                  ? area >= 1280 ** 2 && area <= 1440 ** 2 && width / height >= 0.25 && width / height <= 4
                  : width >= 512 && height >= 512 && width <= 1440 && height <= 1440
      if (!valid) throw new Error('image_dimensions_unsupported')
    }
    if (qwen) {
      const asyncJob = profile === 'qwen-unified'
      const payload = await jsonRequest(
        provider,
        model.protocol,
        asyncJob
          ? '/api/v1/services/aigc/image-generation/generation'
          : '/api/v1/services/aigc/multimodal-generation/generation',
        request,
        {
          model: model.id,
          input: {
            messages: [
              { role: 'user', content: [...input.references.map((image) => ({ image })), { text: input.prompt }] }
            ]
          },
          parameters: { n: 1, ...(input.size !== 'auto' ? { size: input.size.replace('x', '*') } : {}) }
        },
        asyncJob
      )
      if (asyncJob) {
        const id = payload.output?.task_id
        if (typeof id !== 'string' || !remoteId.test(id)) throw new Error('external_job_invalid')
        const remote: CanvasRemoteJob = {
          origin: provider.apiHost,
          submissionId: input.id,
          kind: 'dashscope',
          remoteId: id
        }
        accepted(remote)
        return readExternalImages(provider, remote, request, progress)
      }
      const values = (payload.output?.choices || []).flatMap((choice: Json) =>
        (choice.message?.content || []).map((part: Json) => part.image).filter(Boolean)
      )
      return finish(provider, input, values, request, accepted, progress)
    }
    let body: Json = {
      model: model.id,
      input: { prompt: input.prompt },
      parameters: { n: 1, ...(input.size !== 'auto' ? { size: input.size.replace('x', '*') } : {}) }
    }
    let path = '/api/v1/services/aigc/text2image/image-synthesis'
    if (input.references.length) {
      if (input.references.length !== 1) throw new Error('image_reference_or_count_unsupported')
      path = '/api/v1/services/aigc/image2image/image-synthesis'
      body = {
        model: model.id,
        input: { prompt: input.prompt, base_image_url: input.references[0], function: 'description_edit' },
        parameters: { n: 1 }
      }
      if (input.mask) {
        const alpha = await sharp(decodeImage(input.mask).bytes).extractChannel('alpha').negate().png().toBuffer()
        body.input.mask_image_url = `data:image/png;base64,${alpha.toString('base64')}`
        body.input.function = 'description_edit_with_mask'
      }
    }
    const payload = await jsonRequest(provider, model.protocol, path, request, body, true)
    const id = payload.output?.task_id
    if (typeof id !== 'string' || !remoteId.test(id)) throw new Error('external_job_invalid')
    const remote: CanvasRemoteJob = {
      origin: provider.apiHost,
      submissionId: input.id,
      kind: 'dashscope',
      remoteId: id
    }
    accepted(remote)
    return readExternalImages(provider, remote, request, progress)
  }
  if (model.protocol !== 'comfyui') throw new Error('model_unavailable')
  const workflow = model.configuration?.workflow?.trim()
  const [width, height] = input.size.split('x').map(Number)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width % 8 || height % 8)
    throw new Error('image_dimensions_unsupported')
  if (input.references.length > 1 && !workflow) throw new Error('invalid_workflow')
  if (workflow) {
    if (['prompt', 'model', 'width', 'height'].some((key) => !workflow.includes(`{{${key}}}`)))
      throw new Error('invalid_workflow')
    for (let index = 0; index < input.references.length; index++) {
      if (!workflow.includes(`{{image:${index + 1}}}`) && !(index === 0 && workflow.includes('{{image}}')))
        throw new Error('invalid_workflow')
    }
    if (input.mask && !workflow.includes('{{mask}}')) throw new Error('invalid_workflow')
  }
  const uploaded: string[] = []
  for (const [index, image] of [...input.references, ...(input.mask ? [input.mask] : [])].entries()) {
    const value = decodeImage(image)
    // The built-in latent encoder must honor the selected output dimensions,
    // including the alpha mask. Keep the saved original references untouched.
    if (!workflow) {
      value.bytes = await sharp(value.bytes).resize(width, height, { fit: 'fill' }).png().toBuffer()
      value.mime = 'image/png'
    }
    const form = new FormData()
    form.set(
      'image',
      new Blob([new Uint8Array(value.bytes)], { type: value.mime }),
      `${input.id}-${index}.${value.mime.split('/')[1]}`
    )
    form.set('type', 'input')
    form.set('overwrite', 'false')
    const response = await request(imageEndpoint(provider.apiHost, 'comfyui', '/upload/image'), {
      method: 'POST',
      headers: headersFor(provider),
      body: form,
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(60000)
    })
    if (!response.ok) throw new Error(`upstream_http_${response.status}`)
    const payload = JSON.parse(new TextDecoder().decode(await limitedBytes(response, 1024 * 1024)))
    const name = payload.subfolder ? `${payload.subfolder}/${payload.name}` : payload.name
    if (
      typeof name !== 'string' ||
      !name ||
      name.length > 1000 ||
      name.includes('..') ||
      name.includes('\\') ||
      name.startsWith('/')
    )
      throw new Error('external_job_invalid')
    uploaded.push(name)
  }
  const values: Record<string, string | number> = {
    prompt: input.prompt,
    model: model.id,
    width,
    height,
    seed: randomInt(0, 2147483647),
    image: uploaded[0] || '',
    mask: input.mask ? uploaded.at(-1)! : ''
  }
  uploaded.forEach((image, index) => {
    values[`image:${index + 1}`] = image
  })
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const exact = /^\{\{([^{}]+)\}\}$/.exec(value)
      if (exact) {
        if (!(exact[1] in values) || values[exact[1]] === '') throw new Error('invalid_workflow')
        return values[exact[1]]
      }
      return value.replace(/\{\{([^{}]+)\}\}/g, (_match, key) => {
        if (!(key in values) || values[key] === '') throw new Error('invalid_workflow')
        return String(values[key])
      })
    }
    if (Array.isArray(value)) return value.map(replace)
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    return value
  }
  const prompt = workflow ? replace(JSON.parse(workflow)) : basicWorkflow(model.id, input, uploaded, width, height)
  const payload = await jsonRequest(provider, 'comfyui', '/prompt', request, { prompt, client_id: input.id })
  if (
    typeof payload.prompt_id !== 'string' ||
    !remoteId.test(payload.prompt_id) ||
    (payload.node_errors && Object.keys(payload.node_errors).length)
  )
    throw new Error('external_job_invalid')
  const remote: CanvasRemoteJob = {
    origin: provider.apiHost,
    submissionId: input.id,
    kind: 'comfyui',
    remoteId: payload.prompt_id
  }
  accepted(remote)
  return readExternalImages(provider, remote, request, progress)
}

function basicWorkflow(
  model: string,
  input: ImageCanvasRequest,
  images: string[],
  width: number,
  height: number
): Json {
  const graph: Json = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: input.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: randomInt(0, 2147483647),
        steps: 20,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: input.references.length && !input.mask ? 0.75 : 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0]
      }
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: `Zen-AI/${input.id}`, images: ['6', 0] } }
  }
  if (images.length) {
    graph['9'] = { class_type: 'LoadImage', inputs: { image: images[0] } }
    graph['4'] = { class_type: 'VAEEncode', inputs: { pixels: ['9', 0], vae: ['1', 2] } }
    if (input.mask) {
      graph['10'] = { class_type: 'LoadImage', inputs: { image: images.at(-1) } }
      graph['4'] = {
        class_type: 'VAEEncodeForInpaint',
        inputs: { pixels: ['9', 0], vae: ['1', 2], mask: ['10', 1], grow_mask_by: 6 }
      }
    }
  }
  return graph
}

export async function readExternalImages(
  provider: ImageCanvasProvider,
  remote: CanvasRemoteJob,
  request: ImageFetch,
  progress: ImageCanvasProgress = () => {}
): Promise<Buffer[]> {
  if (remote.origin !== provider.apiHost) throw new Error('provider_configuration_changed')
  if (remote.kind === 'results') return resolveImageResults(remote.results || [], request, progress)
  if (!remote.remoteId || !remoteId.test(remote.remoteId) || !['comfyui', 'dashscope'].includes(remote.kind || ''))
    throw new Error('external_job_invalid')
  const deadline = Date.now() + imageCanvasTimeout
  while (Date.now() < deadline) {
    progress('queued')
    if (remote.kind === 'dashscope') {
      const payload = await jsonRequest(
        provider,
        'dashscope',
        `/api/v1/tasks/${encodeURIComponent(remote.remoteId)}`,
        request
      )
      const state = payload.output?.task_status
      if (state === 'SUCCEEDED')
        return resolveImageResults(
          [
            ...(payload.output.results || []).map((item: Json) => item.url),
            ...(payload.output.choices || []).flatMap((choice: Json) =>
              (choice.message?.content || []).map((part: Json) => part.image)
            )
          ].filter(Boolean),
          request,
          progress
        )
      if (['FAILED', 'CANCELED', 'UNKNOWN'].includes(state)) throw new Error('external_job_failed')
      if (!['PENDING', 'RUNNING'].includes(state)) throw new Error('external_job_invalid')
      if (state === 'RUNNING') progress('generating')
    } else {
      const history = await jsonRequest(provider, 'comfyui', `/history/${encodeURIComponent(remote.remoteId)}`, request)
      const entry = history[remote.remoteId]
      if (entry?.status?.status_str === 'error') throw new Error('external_job_failed')
      if (entry?.status?.completed) {
        const images = Object.values(entry.outputs || {}).flatMap((value: any) => value.images || [])
        if (!images.length || images.length > 4) throw new Error('no_image_result')
        return Promise.all(
          images.map(async (image: Json) => {
            if (
              typeof image.filename !== 'string' ||
              !['output', 'temp'].includes(image.type) ||
              typeof image.subfolder !== 'string'
            )
              throw new Error('external_job_invalid')
            progress('downloading')
            const query = new URLSearchParams({
              filename: image.filename,
              subfolder: image.subfolder,
              type: image.type
            })
            const response = await request(imageEndpoint(provider.apiHost, 'comfyui', `/view?${query}`), {
              headers: headersFor(provider),
              redirect: 'error',
              credentials: 'omit',
              signal: AbortSignal.timeout(60000)
            })
            if (!response.ok) throw new Error(`upstream_http_${response.status}`)
            return Buffer.from(await limitedBytes(response, 20 * 1024 * 1024))
          })
        )
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error('external_job_pending')
}
