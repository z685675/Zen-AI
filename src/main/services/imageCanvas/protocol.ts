import { lookup } from 'node:dns/promises'

import type { ImageCanvasProgress, ImageCanvasProvider, ImageCanvasRequest } from '@shared/config/imageCanvas'
import { validateImageCapabilities } from '@shared/config/imageCapabilities'
import { isZenManagedApiHost } from '@shared/config/zenProvider'
import ipaddr from 'ipaddr.js'
import sharp from 'sharp'

import type { CanvasRemoteJob } from './studio'
import type { StudioAssets } from './StudioAssetCache'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const imageCanvasTimeout = 12 * 60 * 1000
export type ImageFetch = typeof fetch

export function decodeImage(data: string): { mime: string; bytes: Buffer } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data)
  if (!match || match[2].length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) throw new Error('invalid_image')
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('invalid_image')
  const signature =
    match[1] === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === 'image/jpeg'
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
  if (!signature) throw new Error('invalid_image')
  return { mime: match[1], bytes }
}

export function validateCanvasRequest(input: ImageCanvasRequest): void {
  if (input?.batchId !== undefined && (typeof input.batchId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.batchId)))
    throw new Error('invalid_request')
  if (
    !input ||
    typeof input.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(input.id) ||
    typeof input.providerId !== 'string' ||
    input.providerId.length > 300 ||
    typeof input.modelId !== 'string' ||
    input.modelId.length > 300 ||
    typeof input.prompt !== 'string' ||
    !input.prompt.trim() ||
    input.prompt.length > 32000 ||
    !Array.isArray(input.references) ||
    input.references.length > 4 ||
    !Number.isInteger(input.count) ||
    input.count < 1 ||
    input.count > 4 ||
    !['auto', '', 'low', 'medium', 'high', 'standard', 'hd'].includes(input.quality) ||
    !['', 'auto', 'transparent', 'opaque'].includes(input.background) ||
    (input.resolution !== undefined && !['1K', '2K', '4K'].includes(input.resolution)) ||
    (input.aspectRatio !== undefined &&
      (typeof input.aspectRatio !== 'string' || !/^(?:auto|[1-9]\d{0,3}:[1-9]\d{0,3})$/.test(input.aspectRatio))) ||
    typeof input.size !== 'string' ||
    !/^(?:auto|[1-9][0-9]{0,3}:[1-9][0-9]{0,3}|[1-9][0-9]{1,3}x[1-9][0-9]{1,3}|[124]K)?$/.test(input.size)
  )
    throw new Error('invalid_request')
  let total = 0
  if (input.mask !== undefined) {
    if (typeof input.mask !== 'string' || !input.mask.startsWith('data:image/png;')) throw new Error('invalid_mask')
    total += decodeImage(input.mask).bytes.length
  }
  if (input.expansion !== undefined) {
    if (
      !input.expansion ||
      typeof input.expansion !== 'object' ||
      !['top', 'right', 'bottom', 'left'].every((key) => {
        const value = input.expansion![key as keyof typeof input.expansion]
        return Number.isInteger(value) && value >= 0 && value <= 2048
      }) ||
      !Object.values(input.expansion).some((value) => value > 0)
    )
      throw new Error('invalid_expansion')
  }
  if ((input.mask || input.expansion) && (input.references.length !== 1 || (input.mask && input.expansion)))
    throw new Error('invalid_mask')
  for (const reference of input.references) {
    if (typeof reference !== 'string') throw new Error('invalid_image')
    total += decodeImage(reference).bytes.length
  }
  if (total > MAX_IMAGE_BYTES) throw new Error('references_too_large')
}

export function imageEndpoint(host: string, protocol: string, path: string): string {
  // Honor Zen-AI's trailing # convention for an explicit API base path.
  const explicit = host.endsWith('#')
  let base = host.replace(/#$/, '').replace(/\/+$/, '')
  const url = new URL(base)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('invalid_provider_url')
  if (!explicit) {
    if (protocol === 'dashscope') base = base.replace(/\/(?:compatible-mode\/v1|api\/v1)$/, '')
    else if (protocol === 'comfyui') base = base.replace(/\/v1$/, '')
    else if (protocol === 'gemini') base = base.replace(/\/v1(?:beta)?$/, '') + '/v1beta'
    else if (!/\/v\d+(?:beta)?$/.test(base)) base += protocol === 'seedream' ? '/api/v3' : '/v1'
  }
  return `${base}${path}`
}

function sizeFor(input: ImageCanvasRequest, seedream: boolean): string {
  if (!input.size || input.size === 'auto') return seedream ? '2K' : 'auto'
  if (input.size.includes(':')) {
    const [w, h] = input.size.split(':').map(Number)
    if (seedream) {
      const scale = Math.sqrt((2048 * 2048) / (w / h))
      return `${Math.round((scale * w) / h / 16) * 16}x${Math.round(scale / 16) * 16}`
    }
    const exact = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' }[input.size]
    if (!exact) throw new Error('image_dimensions_unsupported')
    return exact
  }
  return input.size
}

export function geminiImageConfig(input: ImageCanvasRequest): Record<string, string> {
  if (input.size === 'auto' || !input.size) return input.resolution ? { imageSize: input.resolution } : {}
  if (input.size.includes(':')) {
    if (!['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'].includes(input.size))
      throw new Error('gemini_size_unsupported')
    return { aspectRatio: input.size, ...(input.resolution ? { imageSize: input.resolution } : {}) }
  }
  const match = /^(\d+)x(\d+)$/.exec(input.size)
  if (!match) throw new Error('gemini_size_unsupported')
  const width = Number(match[1]),
    height = Number(match[2])
  const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
  const ratio = (text: string) => {
    const [w, h] = text.split(':').map(Number)
    return w / h
  }
  const aspectRatio = ratios.reduce(
    (best, value) => (Math.abs(ratio(value) - width / height) < Math.abs(ratio(best) - width / height) ? value : best),
    '1:1'
  )
  return {
    aspectRatio,
    imageSize: input.resolution || (width * height >= 6_000_000 ? '4K' : width * height >= 2_000_000 ? '2K' : '1K')
  }
}

export function validateCanvasModel(provider: ImageCanvasProvider, input: ImageCanvasRequest): void {
  const model = provider.models.find((item) => item.id === input.modelId)
  if (!model) throw new Error('model_unavailable')
  if (provider.id !== input.providerId) throw new Error('provider_unavailable')
  if (model.capabilities) validateImageCapabilities(input, model.capabilities)
  if (!['openai', 'openai-json'].includes(model.protocol) && input.count !== 1) throw new Error('single_image_required')
  if (!['openai', 'openai-json'].includes(model.protocol) && input.background === 'transparent')
    throw new Error('background_unsupported')
  if (!provider.apiKey.trim() && model.protocol !== 'comfyui') throw new Error('provider_key_missing')
  imageEndpoint(provider.apiHost, model.protocol, '')
  if (model.protocol === 'gemini') geminiImageConfig(input)
}

export async function generateCanvasImages(
  provider: ImageCanvasProvider,
  input: ImageCanvasRequest,
  request: ImageFetch,
  accepted: (remote: CanvasRemoteJob) => void = () => {},
  progress: ImageCanvasProgress = () => {},
  studioAssets?: StudioAssets
): Promise<Buffer[]> {
  validateCanvasRequest(input)
  validateCanvasModel(provider, input)
  if (input.mask || input.expansion) input = await prepareImageEdit(input)
  if (isZenManagedApiHost(provider.apiHost)) {
    const { generateStudioImages } = await import('./studio')
    return generateStudioImages(provider, input, request, accepted, progress, studioAssets)
  }
  const model = provider.models.find((item) => item.id === input.modelId)
  if (!model) throw new Error('model_unavailable')
  if (['openai-json', 'chat', 'dashscope', 'comfyui'].includes(model.protocol)) {
    const { generateExternalImages } = await import('./externalImages')
    return generateExternalImages(provider, model, input, request, accepted, progress)
  }
  const headers = new Headers(provider.headers)
  // User headers may customize gateways, but never leak to output/CDN downloads.
  headers.delete('host')
  headers.delete('content-length')
  const key = provider.apiKey
    .split(/(?<!\\),|\r?\n/)
    .map((value) => value.trim().replace(/\\,/g, ','))
    .find(Boolean)
  if (!key) throw new Error('provider_key_missing')
  let path = '/images/generations'
  let body: BodyInit
  if (model.protocol === 'gemini') {
    if (input.count !== 1) throw new Error('gemini_single_image')
    if (input.background === 'transparent') throw new Error('background_unsupported')
    headers.set('x-goog-api-key', key)
    headers.set('Content-Type', 'application/json')
    path = `/models/${encodeURIComponent(model.id.replace(/^models\//, ''))}:generateContent`
    body = JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: input.prompt },
            ...input.references.map((value) => {
              const image = decodeImage(value)
              return { inlineData: { mimeType: image.mime, data: image.bytes.toString('base64') } }
            })
          ]
        }
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: geminiImageConfig(input)
      }
    })
  } else {
    headers.set('Authorization', `Bearer ${key}`)
    const seedream = model.protocol === 'seedream'
    const size = sizeFor(input, seedream)
    if (seedream && input.background === 'transparent') throw new Error('background_unsupported')
    if (seedream && input.count !== 1) throw new Error('seedream_single_request')
    if (input.references.length && !seedream) {
      path = '/images/edits'
      const form = new FormData()
      form.set('model', model.id)
      form.set('prompt', input.prompt)
      form.set('n', String(input.count))
      if (size !== 'auto') form.set('size', size)
      if (input.quality && input.quality !== 'auto') form.set('quality', input.quality)
      if (input.background && input.background !== 'auto') form.set('background', input.background)
      for (const [index, value] of input.references.entries()) {
        const image = decodeImage(value)
        form.append(
          input.references.length === 1 ? 'image' : 'image[]',
          new Blob([new Uint8Array(image.bytes)], { type: image.mime }),
          `reference-${index}.${image.mime.split('/')[1]}`
        )
      }
      if (input.mask) {
        const image = decodeImage(input.mask)
        form.set('mask', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), 'mask.png')
      }
      headers.delete('content-type')
      body = form
    } else {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify({
        model: model.id,
        prompt: input.prompt,
        size,
        ...(seedream
          ? {
              response_format: 'b64_json',
              watermark: false,
              ...(input.references.length ? { image: input.references } : {})
            }
          : {
              n: input.count,
              ...(!model.id.includes('gpt-image') ? { response_format: 'b64_json' } : {}),
              ...(input.quality && input.quality !== 'auto' ? { quality: input.quality } : {}),
              ...(input.background && input.background !== 'auto' ? { background: input.background } : {})
            })
      })
    }
  }
  progress('generating')
  const response = await request(imageEndpoint(provider.apiHost, model.protocol, path), {
    method: 'POST',
    headers,
    body,
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(imageCanvasTimeout)
  })
  // Do not echo upstream responses: they may contain secrets, HTML or signed URLs.
  if (!response.ok) throw new Error(`upstream_http_${response.status}`)
  progress('decoding')
  const payload = JSON.parse(await limitedText(response, 115 * 1024 * 1024))
  const values: string[] =
    model.protocol === 'gemini'
      ? (payload.candidates || [])
          .flatMap((candidate: any) => candidate.content?.parts || [])
          .flatMap((part: any) => {
            const image = part.inlineData || part.inline_data
            return !part.thought && image?.data
              ? [`data:${image.mimeType || image.mime_type || 'image/png'};base64,${image.data}`]
              : []
          })
      : (payload.data || [])
          .map((item: any) => (item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url))
          .filter(Boolean)
  if (!values.length || values.length > 4) throw new Error('no_image_result')
  if (values.every((value) => value.startsWith('https:')))
    accepted({ kind: 'results', origin: provider.apiHost, submissionId: input.id, results: values })
  return resolveImageResults(values, request, progress)
}

export async function resolveImageResults(
  values: string[],
  request: ImageFetch,
  progress: ImageCanvasProgress = () => {}
): Promise<Buffer[]> {
  if (!values.length || values.length > 4 || values.some((value) => typeof value !== 'string'))
    throw new Error('no_image_result')
  return Promise.all(
    values.map(async (value) => {
      if (value.startsWith('data:')) {
        // OpenAI-compatible APIs and Seedream may return PNG, JPEG or WebP in
        // b64_json without a MIME field. Validate actual decoded bytes downstream.
        const raw = value.slice(value.indexOf(',') + 1)
        if (!/^[A-Za-z0-9+/=]+$/.test(raw) || raw.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4)
          throw new Error('invalid_result_image')
        return Buffer.from(raw, 'base64')
      }
      progress('downloading')
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid_result_url')
      const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
      if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast'))
        throw new Error('invalid_result_url')
      const result = await request(url.toString(), {
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(60000)
      })
      if (!result.ok || !/^image\/(png|jpeg|webp)(;|$)/.test(result.headers.get('content-type') || ''))
        throw new Error('invalid_result_image')
      return Buffer.from(await limitedBytes(result, MAX_IMAGE_BYTES))
    })
  )
}

export async function prepareImageEdit(input: ImageCanvasRequest): Promise<ImageCanvasRequest> {
  if (!input.mask && !input.expansion) return input
  const original = decodeImage(input.references[0])
  const metadata = await sharp(original.bytes, { limitInputPixels: 64_000_000 }).metadata()
  const width = metadata.width,
    height = metadata.height
  if (input.mask) {
    const mask = await sharp(decodeImage(input.mask).bytes, { limitInputPixels: 64_000_000 }).metadata()
    if (mask.format !== 'png' || !mask.hasAlpha || mask.width !== width || mask.height !== height)
      throw new Error('invalid_mask')
    const alpha = await sharp(decodeImage(input.mask).bytes).extractChannel('alpha').stats()
    if (alpha.channels[0].min === 255) throw new Error('invalid_mask')
    return input
  }
  const padding = input.expansion!
  const targetWidth = width + padding.left + padding.right,
    targetHeight = height + padding.top + padding.bottom
  if (targetWidth > 8192 || targetHeight > 8192 || targetWidth * targetHeight > 64_000_000)
    throw new Error('invalid_expansion')
  if (input.size !== 'auto' && input.size !== `${targetWidth}x${targetHeight}`)
    throw new Error('image_dimensions_unsupported')
  const image = await sharp(original.bytes)
    .ensureAlpha()
    .extend({ ...padding, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  const kept = await sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .png()
    .toBuffer()
  const mask = await sharp(kept)
    .extend({ ...padding, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  const result = {
    ...input,
    expansion: undefined,
    references: [`data:image/png;base64,${image.toString('base64')}`],
    mask: `data:image/png;base64,${mask.toString('base64')}`
  }
  validateCanvasRequest(result)
  return result
}

export async function limitedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let length = 0
  const reader = response.body?.getReader()
  if (!reader) throw new Error('empty_response')
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > limit) throw new Error('response_too_large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(chunks)
}

async function limitedText(response: Response, limit: number): Promise<string> {
  return new TextDecoder().decode(await limitedBytes(response, limit))
}
