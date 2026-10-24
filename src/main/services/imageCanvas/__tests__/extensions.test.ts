import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ImageCanvasProtocol, ImageCanvasProvider, ImageCanvasRequest } from '@shared/config/imageCanvas'
import { defaultImageCapabilities } from '@shared/config/imageCapabilities'
import sharp from 'sharp'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }))

import { readExternalImages } from '../externalImages'
import { generateCanvasImages, prepareImageEdit } from '../protocol'
import type { CanvasRemoteJob } from '../studio'
import { ImageCanvasTaskStore } from '../TaskStore'

let png: Buffer, image: string
const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'zen-image-extensions-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
beforeAll(async () => {
  png = await sharp({ create: { width: 512, height: 512, channels: 4, background: 'red' } })
    .png()
    .toBuffer()
  image = `data:image/png;base64,${png.toString('base64')}`
})
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
function fixture(protocol: ImageCanvasProtocol, modelId = 'gpt-image-test') {
  const model = { id: modelId, name: modelId, protocol }
  const provider: ImageCanvasProvider = {
    id: 'p',
    name: 'Fixture',
    apiHost: 'https://api.example',
    apiKey: 'private-key',
    models: [{ ...model, capabilities: defaultImageCapabilities(model) }]
  }
  const input: ImageCanvasRequest = {
    id: randomUUID(),
    providerId: 'p',
    modelId,
    prompt: 'test image',
    references: [],
    size: 'auto',
    quality: 'auto',
    background: 'auto',
    count: 1
  }
  return { provider, input }
}

describe('image workbench extension transports', () => {
  it.each(['qwen-image-2.1-pro', 'qwen-image-3.0'])(
    'persists %s async submission and reads choices images without replay',
    async (id) => {
      const { provider, input } = fixture('dashscope', id)
      input.size = '1536x1024'
      input.references = [image, image]
      let remote: CanvasRemoteJob | undefined
      const request = vi.fn(async (url: any, init?: RequestInit) => {
        if (init?.method === 'POST') {
          expect(String(url)).toBe('https://api.example/api/v1/services/aigc/image-generation/generation')
          expect(new Headers(init.headers).get('X-DashScope-Async')).toBe('enable')
          expect(JSON.parse(init.body as string).parameters).toEqual({ n: 1, size: '1536*1024' })
          return response({ output: { task_id: 'qwen-task', task_status: 'PENDING' } })
        }
        expect(remote?.remoteId).toBe('qwen-task')
        return response({ output: { task_status: 'SUCCEEDED', choices: [{ message: { content: [{ image }] } }] } })
      })
      expect(
        await generateCanvasImages(provider, input, request, (value) => {
          remote = value
        })
      ).toEqual([png])
      expect(await readExternalImages(provider, remote!, request)).toEqual([png])
      expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    }
  )
  it('uses legacy Qwen fixed sizes and does not send a custom size to legacy editing', async () => {
    const fixed = fixture('dashscope', 'qwen-image')
    const editing = fixture('dashscope', 'qwen-image-edit')
    const request = vi.fn(async () => response({ output: { choices: [{ message: { content: [{ image }] } }] } }))
    await generateCanvasImages(fixed.provider, { ...fixed.input, size: '1328x1328' }, request)
    await expect(
      generateCanvasImages(fixed.provider, { ...fixed.input, references: [image] }, request)
    ).rejects.toThrow('image_reference_or_count_unsupported')
    await generateCanvasImages(editing.provider, { ...editing.input, references: [image] }, request)
    const calls = request.mock.calls as unknown as [string, RequestInit][]
    expect(JSON.parse(calls[0][1].body as string).parameters.size).toBe('1328*1328')
    expect(JSON.parse(calls[1][1].body as string).parameters).toEqual({ n: 1 })
  })
  it('rejects unsupported native profiles, dimensions and workflows before submission', async () => {
    const request = vi.fn()
    const wan = fixture('dashscope', 'wan2.5-t2i-preview')
    await expect(generateCanvasImages(wan.provider, { ...wan.input, size: '512x512' }, request)).rejects.toThrow(
      'image_dimensions_unsupported'
    )
    const newer = fixture('dashscope', 'wan2.6-t2i')
    await expect(generateCanvasImages(newer.provider, newer.input, request)).rejects.toThrow(
      'dashscope_model_unsupported'
    )
    const comfy = fixture('comfyui', 'sdxl.safetensors')
    comfy.provider.models[0].configuration = {
      protocol: 'comfyui',
      sizes: ['512x512'],
      ratios: [],
      resolutions: [],
      qualities: [],
      backgrounds: [],
      minReferences: 0,
      maxReferences: 1,
      maxImages: 1,
      workflow: JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: 'hardcoded prompt' } } })
    }
    await expect(generateCanvasImages(comfy.provider, { ...comfy.input, size: '512x512' }, request)).rejects.toThrow(
      'invalid_workflow'
    )
    expect(request).not.toHaveBeenCalled()
  })
  it('honors explicit dimensions in the built-in ComfyUI image encoder', async () => {
    const { provider, input } = fixture('comfyui', 'sdxl.safetensors')
    input.size = '768x512'
    input.references = [image]
    const request = vi.fn(async (url: any, init?: RequestInit) => {
      if (String(url).endsWith('/upload/image')) {
        const uploaded = (init!.body as FormData).get('image') as Blob
        const meta = await sharp(Buffer.from(await uploaded.arrayBuffer())).metadata()
        expect([meta.width, meta.height]).toEqual([768, 512])
        return response({ name: 'resized.png', subfolder: '' })
      }
      if (String(url).endsWith('/prompt')) return response({ prompt_id: 'dimensions-test', node_errors: {} })
      if (String(url).includes('/history/'))
        return response({
          'dimensions-test': {
            status: { completed: true },
            outputs: { '7': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } }
          }
        })
      return new Response(new Uint8Array(png))
    })
    expect(await generateCanvasImages(provider, input, request)).toEqual([png])
    expect(input.references).toEqual([image])
  })
  it('binds custom ComfyUI multi-image and mask inputs while preserving numeric node inputs', async () => {
    const { provider, input } = fixture('comfyui', 'custom.safetensors')
    const model = provider.models[0]
    const configuration = {
      protocol: 'comfyui' as const,
      sizes: ['768x512'],
      ratios: [],
      resolutions: [],
      qualities: [],
      backgrounds: [],
      minReferences: 0,
      maxReferences: 2,
      maxImages: 1,
      supportsMask: true,
      workflow: ''
    }
    model.capabilities = { ...model.capabilities!, maxReferences: 2 }
    model.configuration = configuration
    input.size = '768x512'
    let uploads = 0
    const request = vi.fn(async (url: any, init?: RequestInit) => {
      if (String(url).endsWith('/upload/image'))
        return response({ name: `reference-${++uploads}.png`, subfolder: 'inputs' })
      if (String(url).endsWith('/prompt')) {
        const node = JSON.parse(init!.body as string).prompt['1'].inputs
        expect(node).toMatchObject({
          text: 'test image',
          checkpoint: 'custom.safetensors',
          width: 768,
          height: 512,
          seed: expect.any(Number),
          first: 'inputs/reference-1.png',
          second: 'inputs/reference-2.png'
        })
        return response({ prompt_id: 'custom-test', node_errors: {} })
      }
      if (String(url).includes('/history/'))
        return response({
          'custom-test': {
            status: { completed: true },
            outputs: { '7': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } }
          }
        })
      return new Response(new Uint8Array(png))
    })
    for (const masked of [false, true]) {
      uploads = 0
      configuration.workflow = JSON.stringify({
        '1': {
          class_type: 'CustomImageNode',
          inputs: {
            text: '{{prompt}}',
            checkpoint: '{{model}}',
            width: '{{width}}',
            height: '{{height}}',
            seed: '{{seed}}',
            first: '{{image:1}}',
            second: masked ? '{{mask}}' : '{{image:2}}'
          }
        }
      })
      const mask = masked
        ? `data:image/png;base64,${(
            await sharp({ create: { width: 512, height: 512, channels: 4, background: '#00000000' } })
              .png()
              .toBuffer()
          ).toString('base64')}`
        : undefined
      expect(
        await generateCanvasImages(provider, { ...input, references: masked ? [image] : [image, image], mask }, request)
      ).toEqual([png])
    }
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/prompt'))).toHaveLength(2)
  })
  it('sends official JSON edits using image_url objects and a PNG mask', async () => {
    const { provider, input } = fixture('openai-json')
    const mask = await sharp({
      create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
      .png()
      .toBuffer()
    const request = vi.fn(async () => response({ data: [{ b64_json: png.toString('base64') }] }))
    const actual = await generateCanvasImages(
      provider,
      { ...input, references: [image], mask: `data:image/png;base64,${mask.toString('base64')}` },
      request
    )
    expect(actual).toEqual([png])
    const calls = request.mock.calls as unknown as [string, RequestInit][]
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('https://api.example/v1/images/edits')
    expect(JSON.parse(calls[0][1].body as string)).toMatchObject({
      images: [{ image_url: image }],
      mask: { image_url: expect.stringContaining('data:image/png;base64,') }
    })
  })
  it('keeps the explicitly configured gateway image array distinct', async () => {
    const { provider, input } = fixture('openai-json')
    provider.models[0].configuration = {
      protocol: 'openai-json',
      sizes: ['auto'],
      ratios: [],
      resolutions: [],
      qualities: [],
      backgrounds: [],
      minReferences: 0,
      maxReferences: 4,
      maxImages: 1,
      imageField: 'image'
    }
    const request = vi.fn(async () => response({ data: [{ b64_json: png.toString('base64') }] }))
    await generateCanvasImages(provider, { ...input, references: [image, image] }, request)
    const calls = request.mock.calls as unknown as [string, RequestInit][]
    expect(JSON.parse(calls[0][1].body as string)).toMatchObject({ image: [image, image] })
  })
  it('extracts chat message.images and never treats normal text as image success', async () => {
    const { provider, input } = fixture('chat')
    const request = vi.fn(async () =>
      response({
        choices: [{ message: { content: 'Generated', images: [{ type: 'image_url', image_url: { url: image } }] } }]
      })
    )
    expect(await generateCanvasImages(provider, { ...input, references: [image, image] }, request)).toEqual([png])
    const calls = request.mock.calls as unknown as [string, RequestInit][]
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0][1].body as string)
    expect(body).toMatchObject({ stream: false, modalities: ['text', 'image'] })
    expect(body.messages[0].content).toHaveLength(3)
    const empty = vi.fn(async () => response({ choices: [{ message: { content: 'done' } }] }))
    await expect(generateCanvasImages(provider, input, empty)).rejects.toThrow('no_image_result')
    expect(empty).toHaveBeenCalledTimes(1)
  })
  it('does not fall back to another billable endpoint after rejection', async () => {
    const { provider, input } = fixture('chat')
    const request = vi.fn(async () => new Response('private-upstream-error', { status: 400 }))
    await expect(generateCanvasImages(provider, input, request)).rejects.toThrow('upstream_http_400')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('persists a DashScope task before polling and recovers by GET only', async () => {
    const { provider, input } = fixture('dashscope', 'wanx2.1-t2i-turbo')
    input.size = '1024x1024'
    let remote: CanvasRemoteJob | undefined
    const request = vi.fn(async (url: any, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(JSON.parse(init.body as string).parameters.n).toBe(1)
        return response({ output: { task_id: 'task-123', task_status: 'PENDING' } })
      }
      expect(remote?.remoteId).toBe('task-123')
      return response({ output: { task_status: 'SUCCEEDED', results: [{ url: image }] } })
    })
    expect(
      await generateCanvasImages(provider, input, request, (value) => {
        remote = value
      })
    ).toEqual([png])
    expect(remote).toMatchObject({ kind: 'dashscope', remoteId: 'task-123' })
    await readExternalImages(provider, remote!, request)
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
  it('sends Qwen multiple reference Data URLs to the synchronous multimodal endpoint', async () => {
    const { provider, input } = fixture('dashscope', 'qwen-image-2.0-pro')
    input.size = '1024x1024'
    input.references = [image, image]
    const request = vi.fn(async () => response({ output: { choices: [{ message: { content: [{ image }] } }] } }))
    expect(await generateCanvasImages(provider, input, request)).toEqual([png])
    const calls = request.mock.calls as unknown as [string, RequestInit][]
    expect(calls[0][0]).toBe('https://api.example/api/v1/services/aigc/multimodal-generation/generation')
    expect(JSON.parse(calls[0][1].body as string).input.messages[0].content).toEqual([
      { image },
      { image },
      { text: input.prompt }
    ])
    expect(new Headers(calls[0][1].headers).has('X-DashScope-Async')).toBe(false)
  })
  it('runs ComfyUI upload/workflow/history/view and recovers without another prompt POST', async () => {
    const { provider, input } = fixture('comfyui', 'sdxl.safetensors')
    provider.apiKey = ''
    input.size = '512x512'
    input.references = [image]
    let remote: CanvasRemoteJob | undefined
    const request = vi.fn(async (url: any, init?: RequestInit) => {
      if (String(url).endsWith('/upload/image')) return response({ name: 'uploaded.png', subfolder: '' })
      if (String(url).endsWith('/prompt')) {
        const body = JSON.parse(init?.body as string)
        expect(body.prompt['1'].inputs.ckpt_name).toBe('sdxl.safetensors')
        expect(body.prompt['4'].class_type).toBe('VAEEncode')
        return response({ prompt_id: 'prompt-123', node_errors: {} })
      }
      if (String(url).includes('/history/'))
        return response({
          'prompt-123': {
            status: { completed: true, status_str: 'success' },
            outputs: { '7': { images: [{ filename: 'result.png', subfolder: 'Zen-AI', type: 'output' }] } }
          }
        })
      return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } })
    })
    expect(
      await generateCanvasImages(provider, input, request, (value) => {
        remote = value
      })
    ).toEqual([png])
    expect(await readExternalImages(provider, remote!, request)).toEqual([png])
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/prompt'))).toHaveLength(1)
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/upload/image'))).toHaveLength(1)
  })
  it('builds an expanded image and alpha mask without modifying the reference', async () => {
    const { input } = fixture('openai')
    input.references = [image]
    input.expansion = { left: 16, right: 32, top: 48, bottom: 64 }
    const result = await prepareImageEdit(input)
    expect(input.references).toEqual([image])
    const output = await sharp(Buffer.from(result.references[0].split(',')[1], 'base64')).metadata()
    expect([output.width, output.height]).toEqual([560, 624])
    const { data, info } = await sharp(Buffer.from(result.mask!.split(',')[1], 'base64'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(data[3]).toBe(0)
    expect(data[(48 * info.width + 16) * 4 + 3]).toBe(255)
    const request = vi.fn()
    await expect(
      generateCanvasImages(fixture('openai').provider, { ...input, mask: image, expansion: undefined }, request)
    ).rejects.toThrow('invalid_mask')
    expect(request).not.toHaveBeenCalled()
  })
  it('paginates all records after insertion and deletion without losing older history', () => {
    const path = directory()
    const records = Array.from({ length: 151 }, (_, index) => ({
      id: randomUUID(),
      providerId: 'p',
      modelId: 'test',
      prompt: String(index),
      createdAt: new Date(1700000000000 + index * 1000).toISOString(),
      status: 'completed',
      assets: [],
      fingerprint: 'fixture'
    }))
    writeFileSync(join(path, 'tasks.json'), JSON.stringify(records))
    const store = new ImageCanvasTaskStore(path, vi.fn())
    expect(store.history()).toHaveLength(100)
    const first = store.historyPage(undefined, 50)
    store.remove(first.items.at(-1)!.id)
    const next = store.historyPage(first.nextCursor, 100)
    expect(next.items).toHaveLength(100)
    expect(new Set([...first.items, ...next.items].map((task) => task.id)).size).toBe(150)
    expect(store.historyPage(next.nextCursor, 50).items).toHaveLength(1)
    expect(() => store.historyPage('bad-cursor')).toThrow('invalid_history_page')
  })
  it('queues four explicitly selected models with at most two concurrent generations', async () => {
    const path = directory(),
      batchId = randomUUID()
    let active = 0,
      maximum = 0
    const request = vi.fn(async () => {
      active++
      maximum = Math.max(active, maximum)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
      return response({ data: [{ b64_json: png.toString('base64') }] })
    })
    const store = new ImageCanvasTaskStore(path, request)
    const fixtures = Array.from({ length: 4 }, (_, index) => {
      const value = fixture('openai', `gpt-image-${index}`)
      value.input.batchId = batchId
      return value
    })
    const tasks = store.submitBatch(
      fixtures.map((value) => value.provider),
      fixtures.map((value) => value.input)
    )
    expect(tasks).toHaveLength(4)
    expect(tasks.filter((task) => task.phase === 'queued')).toHaveLength(2)
    await vi.waitFor(() => expect(store.history().every((task) => task.status === 'completed')).toBe(true))
    expect(maximum).toBe(2)
    expect(request).toHaveBeenCalledTimes(4)
    const saved = JSON.parse(readFileSync(join(path, 'tasks.json'), 'utf8'))
    expect(saved.every((task: any) => task.batchId === batchId)).toBe(true)
    expect(JSON.stringify(saved)).not.toContain('private-key')
  })
})
