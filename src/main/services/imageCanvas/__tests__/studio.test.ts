import { randomUUID } from 'node:crypto'

import type { ImageCanvasProvider, ImageCanvasRequest } from '@shared/config/imageCanvas'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateCanvasImages } from '../protocol'
import { readStudioImages, studioModels } from '../studio'

const provider: ImageCanvasProvider = {
  id: 'zen',
  name: 'Zen',
  apiHost: 'https://zenai.925636.xyz',
  apiKey: 'secret-key',
  models: [{ id: 'gpt-image-2', name: 'Image', protocol: 'openai' }]
}
const input = (): ImageCanvasRequest => ({
  id: randomUUID(),
  providerId: 'zen',
  modelId: 'gpt-image-2',
  prompt: 'a house',
  references: [],
  size: '1:1',
  quality: 'auto',
  background: '',
  count: 1
})
const assetId = 'a'.repeat(64)
const job = { job: { state: 'succeeded' }, assets: [assetId] }
const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }))
const bootstrap = () =>
  json({
    submission_lookup: true,
    models: [
      {
        id: 'gpt-image-2',
        protocol: 'images',
        sizes: ['auto', '1024x1024'],
        qualities: ['auto', 'high'],
        backgrounds: ['auto'],
        max_references: 4,
        max_images: 4
      }
    ]
  })

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('background Zen image jobs', () => {
  it('offers common resolutions and submits 4K unchanged even when server metadata only lists 1K', async () => {
    const source: ImageCanvasProvider = {
      ...provider,
      models: [{ id: 'gemini-2.5-flash-image', name: 'Image', protocol: 'gemini' }]
    }
    const models = [
      {
        id: source.models[0].id,
        protocol: 'gemini',
        sizes: ['1K'],
        aspect_ratios: ['1:1'],
        qualities: [],
        backgrounds: [],
        max_references: 0,
        max_images: 1
      }
    ]
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/bootstrap')) return json({ submission_lookup: true, models })
      if (url.endsWith('/jobs')) {
        expect(JSON.parse(init!.body as string)).toMatchObject({ size: '4K', aspect_ratio: '16:9' })
        return json(job)
      }
      return new Response(new Uint8Array([1]))
    })
    const catalog = await studioModels(source, request)
    expect(catalog[0].capabilities?.dimensions).toContainEqual({ ratio: '16:9', size: '16:9', resolution: '4K' })
    await generateCanvasImages(
      { ...source, models: catalog },
      { ...input(), modelId: source.models[0].id, size: '16:9', aspectRatio: '16:9', resolution: '4K' },
      request
    )
    expect(request.mock.calls.filter(([url]) => url.endsWith('/jobs'))).toHaveLength(1)
  })
  it.each([
    ['seedream', 'seedream'],
    ['images-json', 'openai-json'],
    ['images-json-image', 'openai-json'],
    ['chat', 'chat']
  ])('accepts the declared %s server transport without probing generation', async (protocol, expected) => {
    const request = vi.fn(async () =>
      json({
        submission_lookup: true,
        models: [
          {
            id: 'gpt-image-2',
            protocol,
            sizes: [],
            aspect_ratios: [],
            qualities: [],
            backgrounds: [],
            max_references: 2,
            max_images: 4,
            supports_mask: protocol.startsWith('images')
          }
        ]
      })
    )
    const models = await studioModels(provider, request)
    expect(models[0].protocol).toBe(expected)
    expect(models[0].capabilities?.maxImages).toBe(protocol.startsWith('images') ? 4 : 1)
    expect(request).toHaveBeenCalledOnce()
  })
  it('passes only bounded server timing fields and known error codes without generating again', async () => {
    const progress = vi.fn()
    const request = vi.fn()
    const id = randomUUID()
    await expect(
      readStudioImages(
        provider,
        { origin: new URL(provider.apiHost).origin, submissionId: randomUUID() },
        request,
        {
          job: {
            id,
            state: 'storage_failed',
            queue_ms: 1250,
            relay_ms: 245000,
            archiving_ms: 5000,
            relay_status: 200,
            failed_stage: 'archiving',
            error_code: 'image_download_failed'
          },
          assets: []
        },
        progress
      )
    ).rejects.toThrow('studio_server_image_download_failed')
    expect(progress).toHaveBeenLastCalledWith('archiving', undefined, {
      jobId: id,
      phaseDurationsMs: { queued: 1250, relay: 245000, archiving: 5000 },
      httpStatus: 200,
      errorCode: 'image_download_failed'
    })
    expect(request).not.toHaveBeenCalled()
    progress.mockClear()
    await expect(
      readStudioImages(
        provider,
        { origin: new URL(provider.apiHost).origin, submissionId: randomUUID() },
        request,
        {
          job: {
            id,
            state: 'failed',
            queue_ms: -1,
            relay_ms: Infinity,
            archiving_ms: 0,
            relay_status: 999,
            error_code: 'private_upstream_body'
          },
          assets: []
        },
        progress
      )
    ).rejects.toThrow('studio_generation_failed')
    expect(progress).toHaveBeenLastCalledWith('generating', undefined, {
      jobId: id,
      phaseDurationsMs: { archiving: 0 }
    })
  })
  it('uses the server transport for a Gemini-named Images gateway and hides unsupported transports', async () => {
    const gateway: ImageCanvasProvider = {
      ...provider,
      models: [{ id: 'gemini-3-pro-image-preview', name: 'Gemini', protocol: 'gemini' }]
    }
    const models = [
      {
        id: gateway.models[0].id,
        protocol: 'images',
        sizes: ['1024x1024'],
        qualities: [],
        backgrounds: [],
        max_references: 0,
        max_images: 1
      }
    ]
    const request = vi.fn().mockImplementation(async () => json({ submission_lookup: true, models }))
    const catalog = await studioModels(gateway, request)
    expect(catalog).toMatchObject([{ protocol: 'openai', capabilities: { maxReferences: 0 } }])
    expect(catalog[0].capabilities?.dimensions).toContainEqual({ ratio: '1:1', size: '1024x1024' })
    models[0].protocol = 'unsupported'
    expect(await studioModels(gateway, request)).toEqual([])
    expect(request.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
  })
  it('uses the original job capability snapshot during read-only recovery', async () => {
    const progress = vi.fn()
    const request = vi.fn().mockResolvedValue(new Response('asset'))
    await readStudioImages(
      provider,
      { origin: new URL(provider.apiHost).origin, submissionId: randomUUID() },
      request,
      { ...job, capability: { protocol: 'gemini', revision: 'a'.repeat(16) } },
      progress
    )
    expect(progress).toHaveBeenCalledWith('downloading', {
      protocol: 'gemini',
      capabilitySource: 'server',
      capabilityRevision: 'a'.repeat(16)
    })
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][1].method).toBe('GET')
  })
  it('reports queued, generating, archiving and downloading without another generation request', async () => {
    vi.useFakeTimers()
    const states = ['running', 'archiving', 'succeeded']
    const request = vi
      .fn()
      .mockImplementation(async (url) =>
        url.includes('/assets/') ? new Response('asset') : json({ job: { state: states.shift() }, assets: [assetId] })
      )
    const progress = vi.fn()
    const pending = readStudioImages(
      provider,
      { origin: new URL(provider.apiHost).origin, submissionId: randomUUID() },
      request,
      { job: { state: 'queued' }, assets: [] },
      progress
    )
    await vi.advanceTimersByTimeAsync(6000)
    await expect(pending).resolves.toHaveLength(1)
    expect(progress.mock.calls.map(([phase]) => phase)).toEqual([
      'queued',
      'queued',
      'generating',
      'archiving',
      'downloading'
    ])
    expect(request.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
  })
  it('requires a server upgrade before sending a billable request to an old gateway', async () => {
    const request = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    await expect(generateCanvasImages(provider, input(), request)).rejects.toThrow('studio_upgrade_required')
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][1].method).toBe('GET')
  })

  it('requires submission lookup support before a billable request even when bootstrap exists', async () => {
    const request = vi.fn().mockResolvedValue(json({ models: [] }))
    await expect(generateCanvasImages(provider, input(), request)).rejects.toThrow('studio_upgrade_required')
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][1].method).toBe('GET')
  })

  it('maps native Gemini resolution and ratio without OpenAI parameters', async () => {
    const gemini = {
      ...provider,
      models: [{ id: 'gemini-3-pro-image-preview', name: 'Gemini', protocol: 'openai' as const }]
    }
    const request = vi.fn().mockImplementation(async (url, init) => {
      if (url.endsWith('/bootstrap'))
        return json({
          submission_lookup: true,
          models: [
            {
              id: gemini.models[0].id,
              protocol: 'gemini',
              sizes: ['1K', '2K', '4K'],
              qualities: [],
              backgrounds: [],
              max_references: 4,
              max_images: 1
            }
          ]
        })
      if (url.endsWith('/jobs')) {
        const body = JSON.parse(init.body)
        expect(body).toMatchObject({ size: '4K', aspect_ratio: '16:9', n: 1 })
        expect(body).not.toHaveProperty('quality')
        expect(body).not.toHaveProperty('background')
        return json(job)
      }
      return new Response('native Gemini image')
    })
    expect(
      await generateCanvasImages(
        gemini,
        {
          ...input(),
          modelId: gemini.models[0].id,
          size: '4096x2304',
          resolution: '4K',
          quality: 'high',
          background: 'opaque'
        },
        request
      )
    ).toEqual([Buffer.from('native Gemini image')])
  })

  it('rejects unsupported explicit parameters before sending a generation request', async () => {
    const request = vi.fn().mockImplementation(async () => bootstrap())
    await expect(generateCanvasImages(provider, { ...input(), quality: 'hd' }, request)).rejects.toThrow(
      'studio_parameters_unsupported'
    )
    expect(request).toHaveBeenCalledOnce()
  })

  it('submits once, persists the identity first and polls a short status request for a long generation', async () => {
    const payload = input()
    const accepted = vi.fn()
    const request = vi.fn().mockImplementation(async (url, init) => {
      if (url.endsWith('/bootstrap')) return bootstrap()
      if (url.endsWith('/jobs')) {
        expect(accepted).toHaveBeenCalledWith({ origin: 'https://zenai.925636.xyz', submissionId: payload.id })
        expect(new Headers(init.headers).get('Idempotency-Key')).toBe(payload.id)
        expect(JSON.parse(init.body)).toMatchObject({ size: '1024x1024', n: 1 })
        return json({ job: { state: 'running' }, assets: [] })
      }
      if (url.includes('/jobs/by-submission/')) return json(job)
      if (url.endsWith(`/assets/${assetId}`)) return new Response('image bytes')
      throw new Error('unexpected request')
    })
    expect(await generateCanvasImages(provider, payload, request, accepted)).toEqual([Buffer.from('image bytes')])
    expect(request.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
    expect(request.mock.calls.some(([url]) => url.includes('/images/generations'))).toBe(false)
  })

  it('recovers a lost creation response by submission identity without another generation POST', async () => {
    const request = vi.fn().mockImplementation(async (url) => {
      if (url.endsWith('/bootstrap')) return bootstrap()
      if (url.endsWith('/jobs')) throw new TypeError('connection lost')
      if (url.includes('/jobs/by-submission/')) return json(job)
      return new Response('recovered image')
    })
    expect(await generateCanvasImages(provider, input(), request)).toEqual([Buffer.from('recovered image')])
    expect(request.mock.calls.filter(([url]) => url.endsWith('/jobs'))).toHaveLength(1)
  })

  it('resumes only reads and refuses to send credentials to a changed provider origin', async () => {
    const remote = { origin: 'https://zenai.925636.xyz', submissionId: randomUUID() }
    const request = vi
      .fn()
      .mockImplementation(async (url) => (url.includes('/jobs/') ? json(job) : new Response('saved')))
    await readStudioImages(provider, remote, request)
    expect(request.mock.calls.every(([, init]) => !init.method || init.method === 'GET')).toBe(true)
    await expect(readStudioImages({ ...provider, apiHost: 'https://changed.test' }, remote, request)).rejects.toThrow(
      'studio_job_unavailable'
    )
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('recovers network and response-body failures without repeating the generation POST', async () => {
    vi.useFakeTimers()
    let downloads = 0
    const request = vi.fn().mockImplementation(async (url) => {
      if (url.endsWith('/bootstrap')) return bootstrap()
      if (url.endsWith('/jobs')) return json(job)
      downloads++
      if (downloads === 1) throw new TypeError('connection lost')
      if (downloads === 2)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException('body interrupted', 'AbortError'))
            }
          })
        )
      return new Response('recovered image')
    })
    const result = generateCanvasImages(provider, input(), request)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await result).toEqual([Buffer.from('recovered image')])
    expect(request.mock.calls.filter(([url]) => url.endsWith('/jobs'))).toHaveLength(1)
    const reads = request.mock.calls.filter(([url]) => url.endsWith(`/assets/${assetId}`))
    expect(reads).toHaveLength(3)
    expect(reads.every(([, init]) => init.method === 'GET')).toBe(true)
    expect(new Set(reads.map(([, init]) => init.signal)).size).toBe(3)
  })

  it('stops after three failed downloads and exposes a recoverable download error', async () => {
    vi.useFakeTimers()
    const request = vi.fn().mockRejectedValue(new TypeError('connection lost; secret-key'))
    const remote = { origin: new URL(provider.apiHost).origin, submissionId: randomUUID() }
    const result = expect(readStudioImages(provider, remote, request, job)).rejects.toThrow('studio_download_failed')
    await vi.advanceTimersByTimeAsync(3000)
    await result
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true)
  })

  it('restarts a timed-out HTTP 200 body download with a fresh timeout', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal)
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(stream) {
              setTimeout(() => {
                controller.abort(new DOMException('timed out', 'TimeoutError'))
                stream.error(controller.signal.reason)
              }, 60000)
            }
          })
        )
      )
      .mockResolvedValueOnce(new Response('image'))
    const remote = { origin: new URL(provider.apiHost).origin, submissionId: randomUUID() }
    const result = readStudioImages(provider, remote, request, job)
    await vi.advanceTimersByTimeAsync(61000)
    expect(await result).toEqual([Buffer.from('image')])
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0][1].signal.aborted).toBe(true)
    expect(request.mock.calls[1][1].signal.aborted).toBe(false)
  })

  it.each([400, 401, 403, 404, 413])('does not retry a permanent HTTP %s asset error', async (status) => {
    const request = vi.fn().mockResolvedValue(new Response('unavailable', { status }))
    const remote = { origin: new URL(provider.apiHost).origin, submissionId: randomUUID() }
    await expect(readStudioImages(provider, remote, request, job)).rejects.toThrow('studio_download_failed')
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([408, 429, 500, 502, 503, 504])('retries a temporary HTTP %s asset error', async (status) => {
    vi.useFakeTimers()
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status }))
      .mockResolvedValueOnce(new Response('image'))
    const remote = { origin: new URL(provider.apiHost).origin, submissionId: randomUUID() }
    const result = readStudioImages(provider, remote, request, job)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toEqual([Buffer.from('image')])
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('retries an empty successful response instead of trying to save an empty image', async () => {
    vi.useFakeTimers()
    const request = vi.fn().mockResolvedValueOnce(new Response('')).mockResolvedValueOnce(new Response('image'))
    const remote = { origin: new URL(provider.apiHost).origin, submissionId: randomUUID() }
    const result = readStudioImages(provider, remote, request, job)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toEqual([Buffer.from('image')])
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not download an oversized result repeatedly', async () => {
    const request = vi.fn().mockResolvedValue(new Response(new Uint8Array(20 * 1024 * 1024 + 1)))
    const remote = { origin: new URL(provider.apiHost).origin, submissionId: randomUUID() }
    await expect(readStudioImages(provider, remote, request, job)).rejects.toThrow('result_too_large')
    expect(request).toHaveBeenCalledOnce()
  })
})
