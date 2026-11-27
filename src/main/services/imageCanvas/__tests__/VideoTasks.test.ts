import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ImageCanvasProvider } from '@shared/config/imageCanvas'
import type { VideoRequest } from '@shared/config/videoGeneration'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VideoTasks } from '../VideoTasks'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')

const provider: ImageCanvasProvider = {
  id: 'gateway',
  name: 'Test gateway',
  apiHost: 'https://test.example',
  apiKey: 'fixture-key,another-key',
  models: []
}
const modelId = 'vendor/any-video-alias'
const clip = new Uint8Array(Buffer.from('00000014667479706d70343200000000', 'hex'))
const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'zen-video-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const request = (): VideoRequest => ({
  id: randomUUID(),
  providerId: provider.id,
  modelId,
  prompt: 'Pan left',
  size: '1280x720',
  seconds: 10
})

describe('video generation tasks', () => {
  it('sends the selected duration and first frame, then retries only the download after reopening', async () => {
    const data = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'blue' } })
      .png()
      .toBuffer()
    const input = { ...request(), firstFrame: `data:image/png;base64,${data.toString('base64')}` }
    const path = directory()
    let downloads = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (value, init) => {
      const url = String(value)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-key')
      if (init?.method === 'POST') {
        expect(url).toBe('https://test.example/v1/videos')
        const body = init.body as FormData
        expect(new Headers(init.headers).has('content-type')).toBe(false)
        expect(body.get('model')).toBe(modelId)
        expect(body.get('seconds')).toBe('10')
        expect(body.get('size')).toBe('1280x720')
        expect(body.has('metadata')).toBe(false)
        const frame = body.get('input_reference') as File
        expect(frame.type).toBe('image/png')
        expect(Buffer.from(await frame.arrayBuffer())).toEqual(data)
        return Response.json({ id: 'task_remote', status: 'queued' })
      }
      if (url.endsWith('/content')) return ++downloads === 1 ? new Response(null, { status: 502 }) : new Response(clip)
      expect(url).toBe('https://test.example/v1/videos/task_remote')
      return Response.json({ status: 'completed' })
    })
    const store = new VideoTasks(path, fetch)
    expect(store.submit(provider, input)).toMatchObject({ status: 'submitting' })
    await vi.waitFor(() =>
      expect(store.history()[0]).toMatchObject({ status: 'uncertain', recoverable: true, readyToDownload: true })
    )
    const restored = new VideoTasks(path, fetch)
    restored.recover(provider, input.id)
    await vi.waitFor(() => expect(restored.history()[0].status).toBe('completed'))
    expect(await restored.preview(input.id)).toEqual(clip)
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET', undefined, undefined])
    const persisted = readFileSync(join(path, 'tasks.json'), 'utf8')
    expect(persisted).not.toContain('fixture-key')
    expect(persisted).not.toContain('data:image')
  })

  it('redownloads an unplayable completed video without submitting again or reusing the bad file', async () => {
    let downloads = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === 'POST') return Response.json({ id: 'task_repair' })
      if (String(url).endsWith('/content'))
        return ++downloads === 2 ? new Response(null, { status: 502 }) : new Response(clip)
      return Response.json({ status: 'completed' })
    })
    const path = directory()
    const store = new VideoTasks(path, fetch)
    const input = request()
    store.submit(provider, input)
    await vi.waitFor(() => expect(store.history()[0]).toMatchObject({ status: 'completed', recoverable: true }))

    const file = store.file(input.id)
    writeFileSync(file, 'unplayable')
    store.recover(provider, input.id)
    await vi.waitFor(() => expect(store.history()[0]).toMatchObject({ status: 'uncertain', error: 'video_http_502' }))
    expect(readFileSync(file, 'utf8')).toBe('unplayable')

    const restored = new VideoTasks(path, fetch)
    restored.recover(provider, input.id)
    await vi.waitFor(() => expect(restored.history()[0].status).toBe('completed'))
    expect(await restored.preview(input.id)).toEqual(clip)
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET', undefined, undefined, undefined])
  })

  it.each([
    { headers: { 'content-length': String(clip.length) }, totalBytes: clip.length },
    { headers: {}, totalBytes: undefined },
    { headers: { 'content-length': '4', 'content-encoding': 'gzip' }, totalBytes: undefined }
  ])('reports streamed video progress with total size $totalBytes', async ({ headers, totalBytes }) => {
    const { readable, writable } = new TransformStream<Uint8Array>()
    const writer = writable.getWriter()
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === 'POST') return Response.json({ id: 'task_progress', status: 'queued' })
      if (String(url).endsWith('/content')) return new Response(readable, { headers: new Headers(headers) })
      return Response.json({ status: 'completed' })
    })
    const path = directory()
    const store = new VideoTasks(path, fetch)
    const input = request()
    store.submit(provider, input)
    await writer.write(clip.subarray(0, 8))
    await vi.waitFor(() =>
      expect(store.history()[0]).toMatchObject({
        status: 'downloading',
        readyToDownload: true,
        download: { receivedBytes: 8, totalBytes }
      })
    )
    expect(readFileSync(join(path, 'tasks.json'), 'utf8')).not.toContain('receivedBytes')
    await writer.write(clip.subarray(8))
    await writer.close()
    await vi.waitFor(() => expect(store.history()[0].status).toBe('completed'))
    expect(store.history()[0].download).toBeUndefined()
    expect(await store.preview(input.id)).toEqual(clip)
  })

  it('leaves unspecified settings to the model and supports a gateway result envelope', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === 'POST') {
        const body = init.body as FormData
        expect(Array.from(body.keys())).toEqual(['model', 'prompt'])
        return Response.json({ data: { task_id: 'vendor_job' } })
      }
      if (String(url).endsWith('/content')) return new Response(clip)
      return Response.json({ data: { status: 'SUCCESS' } })
    })
    const store = new VideoTasks(directory(), fetch)
    store.submit(provider, { ...request(), size: undefined, seconds: undefined })
    await vi.waitFor(() => expect(store.history()[0].status).toBe('completed'))
  })

  it.each([false, true])('switches to JSON after a 415 with first frame enabled = %s', async (withFrame) => {
    const data = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'blue' } })
      .png()
      .toBuffer()
    const firstFrame = withFrame ? `data:image/png;base64,${data.toString('base64')}` : undefined
    const input = { ...request(), modelId: 'grok-imagine-video-1.5', seconds: 4, size: undefined, firstFrame }
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === 'POST') {
        if (init.body instanceof FormData) return new Response(null, { status: 415 })
        expect(url).toBe('https://test.example/v1/videos')
        expect(new Headers(init.headers).get('content-type')).toBe('application/json')
        expect(JSON.parse(init.body as string)).toEqual({
          model: input.modelId,
          prompt: input.prompt,
          seconds: '4',
          ...(firstFrame ? { input_reference: firstFrame } : {})
        })
        return Response.json({ id: 'task_json', status: 'queued' })
      }
      if (String(url).endsWith('/content')) return new Response(clip)
      return Response.json({ status: 'completed' })
    })
    const store = new VideoTasks(directory(), fetch)
    store.submit(provider, input)
    await vi.waitFor(() => expect(store.history()[0].status).toBe('completed'))
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'POST', 'GET', undefined])
  })

  it('does not replay a submission with an uncertain server error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 502 }))
    const store = new VideoTasks(directory(), fetch)
    store.submit(provider, request())
    await vi.waitFor(() =>
      expect(store.history()[0]).toMatchObject({ status: 'uncertain', error: 'video_http_502', recoverable: false })
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid seconds without submitting a request', () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const store = new VideoTasks(directory(), fetch)
    expect(() => store.submit(provider, { ...request(), seconds: -1 })).toThrow('video_parameters_unsupported')
    expect(fetch).not.toHaveBeenCalled()
  })
})
