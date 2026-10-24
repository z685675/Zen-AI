import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ImageCanvasProvider, ImageCanvasRequest } from '@shared/config/imageCanvas'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')

import { ImageCanvasTaskStore } from '../TaskStore'

const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'zen-canvas-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const provider: ImageCanvasProvider = {
  id: 'p',
  name: 'Test',
  apiHost: 'https://example.test',
  apiKey: 'never-persist-this-key',
  models: [{ id: 'gpt-image-test', name: 'Test', protocol: 'openai' }]
}
const input = (): ImageCanvasRequest => ({
  id: randomUUID(),
  providerId: 'p',
  modelId: 'gpt-image-test',
  prompt: 'Test image',
  references: [],
  count: 1,
  size: '1:1',
  quality: 'auto',
  background: ''
})

describe('durable image canvas tasks', () => {
  it('reads a legacy server resolution preflight rejection as failed without recovery or another submission', async () => {
    const zen: ImageCanvasProvider = { ...provider, apiHost: 'https://zenai.925636.xyz' }
    const request = vi.fn(async (url: string) => {
      if (url.endsWith('/bootstrap'))
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              submission_lookup: true,
              models: [
                {
                  id: 'gpt-image-test',
                  protocol: 'images',
                  sizes: ['1024x1024'],
                  qualities: [],
                  backgrounds: [],
                  max_references: 0,
                  max_images: 1
                }
              ]
            }
          })
        )
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            job: {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              state: 'failed',
              error_code: 'image_resolution_unavailable',
              failed_stage: 'preparing'
            },
            assets: []
          }
        })
      )
    })
    const store = new ImageCanvasTaskStore(directory(), request)
    const payload = { ...input(), size: 'auto' }
    store.submit(zen, payload)
    await vi.waitFor(() => expect(store.task(payload.id)?.status).toBe('failed'))
    expect(store.task(payload.id)).toMatchObject({
      recoverable: false,
      error: 'studio_server_image_resolution_unavailable',
      diagnostics: { failedPhase: 'preparing' }
    })
    expect(request.mock.calls.filter(([url]) => url.endsWith('/jobs'))).toHaveLength(1)
  })
  it('includes the current phase in live timing snapshots without changing durable counters', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(100)
    let respond: (response: Response) => void = () => {}
    const request = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve
        })
    )
    const path = directory()
    const store = new ImageCanvasTaskStore(path, request)
    const payload = input()
    try {
      store.submit(provider, payload)
      now.mockReturnValue(1100)
      expect(store.task(payload.id)?.diagnostics?.phaseDurationsMs.generating).toBe(1000)
      expect(store.task(payload.id)?.diagnostics?.phaseDurationsMs.generating).toBe(1000)
      expect(
        JSON.parse(readFileSync(join(path, 'tasks.json'), 'utf8'))[0].diagnostics.phaseDurationsMs.generating
      ).toBeUndefined()
      respond(new Response('', { status: 400 }))
      await vi.waitFor(() => expect(store.task(payload.id)?.status).toBe('failed'))
      expect(store.task(payload.id)?.diagnostics?.phaseDurationsMs.generating).toBe(1000)
    } finally {
      now.mockRestore()
    }
  })
  it('deduplicates accepted requests, archives images and restores results without another upstream request', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
      .png()
      .toBuffer()
    const request = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })))
    const path = directory()
    const store = new ImageCanvasTaskStore(path, request)
    const payload = input()
    store.submit(provider, payload)
    store.submit(provider, payload)
    await vi.waitFor(() => expect(store.task(payload.id)?.status).toBe('completed'))
    expect(request).toHaveBeenCalledOnce()
    const restored = new ImageCanvasTaskStore(path, request)
    restored.submit(provider, payload)
    expect(request).toHaveBeenCalledOnce()
    expect(await restored.asset(restored.task(payload.id)!.assets[0])).toMatch(/^data:image\/png;base64,/)
    expect(readFileSync(join(path, 'tasks.json'), 'utf8')).not.toContain(provider.apiKey)
    expect(restored.task(payload.id)?.diagnostics).toMatchObject({
      protocol: 'openai',
      capabilitySource: 'builtin',
      attempts: 1,
      capabilityRevision: expect.stringMatching(/^[a-f0-9]{16}$/),
      finishedAt: expect.any(String),
      phaseDurationsMs: { generating: expect.any(Number), decoding: expect.any(Number), saving: expect.any(Number) }
    })
    expect(() => restored.submit(provider, { ...payload, prompt: 'different paid request' })).toThrow(
      'request_id_conflict'
    )
    await expect(restored.asset('../secret')).rejects.toThrow('asset_unavailable')
  })

  it('does not replay interrupted tasks after restart', () => {
    const path = directory()
    const payload = input()
    writeFileSync(
      join(path, 'tasks.json'),
      JSON.stringify([
        { ...payload, status: 'running', createdAt: new Date().toISOString(), assets: [], fingerprint: 'existing' }
      ])
    )
    const request = vi.fn()
    const store = new ImageCanvasTaskStore(path, request)
    expect(store.task(payload.id)).toMatchObject({ status: 'uncertain', error: 'interrupted_check_provider' })
    expect(request).not.toHaveBeenCalled()
  })

  it('saves a generated image automatically after a temporary download failure', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
      .png()
      .toBuffer()
    const payload = { ...input(), size: '4096x4096' }
    const zen = { ...provider, apiHost: 'https://zenai.925636.xyz' }
    const assetId = 'b'.repeat(64)
    const serverJobId = randomUUID()
    let downloads = 0
    const request = vi.fn().mockImplementation(async (url) => {
      if (url.endsWith('/bootstrap'))
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              submission_lookup: true,
              models: [
                {
                  id: payload.modelId,
                  protocol: 'images',
                  sizes: ['1024x1024'],
                  qualities: [],
                  backgrounds: [],
                  max_references: 4,
                  max_images: 1
                }
              ]
            }
          })
        )
      if (url.endsWith('/jobs'))
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              job: { id: serverJobId, state: 'succeeded', relay_ms: 245000, archiving_ms: 2000, relay_status: 200 },
              assets: [assetId]
            }
          })
        )
      downloads++
      if (downloads === 1) throw new TypeError('connection lost')
      return new Response(new Uint8Array(png))
    })
    const store = new ImageCanvasTaskStore(directory(), request)
    store.submit(zen, payload)
    await vi.waitFor(() => expect(store.task(payload.id)?.status).toBe('completed'), { timeout: 5000 })
    expect(downloads).toBe(2)
    expect(store.task(payload.id)?.outputSizes).toEqual(['2x2'])
    expect(store.task(payload.id)?.diagnostics).toMatchObject({
      protocol: 'openai',
      capabilitySource: 'server',
      capabilityRevision: 'server-unversioned',
      attempts: 1,
      phaseDurationsMs: { downloading: expect.any(Number) },
      server: { jobId: serverJobId, phaseDurationsMs: { relay: 245000, archiving: 2000 }, httpStatus: 200 }
    })
    expect(store.task(payload.id)?.diagnostics?.phaseDurationsMs.downloading).toBeGreaterThanOrEqual(900)
    expect(request.mock.calls.filter(([url]) => url.endsWith('/jobs'))).toHaveLength(1)
    expect(await store.asset(store.task(payload.id)!.assets[0])).toMatch(/^data:image\/png;base64,/)
  })

  it('records ambiguous failures and never retries a possibly billed POST', async () => {
    const request = vi.fn().mockRejectedValue(new Error('socket lost after POST; secret-key'))
    const store = new ImageCanvasTaskStore(directory(), request)
    const payload = input()
    store.submit(provider, payload)
    await vi.waitFor(() => expect(store.task(payload.id)?.status).toBe('uncertain'))
    store.submit(provider, payload)
    expect(request).toHaveBeenCalledOnce()
    expect(store.task(payload.id)?.error).not.toContain('secret-key')
    expect(store.task(payload.id)?.diagnostics?.failedPhase).toBe('generating')
  })

  it('recovers a persisted remote job with reads only after restart', async () => {
    const path = directory()
    const payload = input()
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
      .png()
      .toBuffer()
    writeFileSync(
      join(path, 'tasks.json'),
      JSON.stringify([
        {
          id: payload.id,
          providerId: 'p',
          modelId: payload.modelId,
          prompt: payload.prompt,
          status: 'running',
          createdAt: new Date().toISOString(),
          assets: [],
          fingerprint: 'old',
          remote: { origin: 'https://zenai.925636.xyz', submissionId: payload.id }
        }
      ])
    )
    const asset = randomUUID()
    const request = vi
      .fn()
      .mockImplementation(async (url) =>
        url.includes('/jobs/')
          ? new Response(JSON.stringify({ success: true, data: { job: { state: 'succeeded' }, assets: [asset] } }))
          : new Response(new Uint8Array(png))
      )
    const store = new ImageCanvasTaskStore(path, request)
    expect(store.task(payload.id)).toMatchObject({ status: 'uncertain', recoverable: true })
    store.recover({ ...provider, apiHost: 'https://zenai.925636.xyz' }, payload.id)
    await vi.waitFor(() => expect(store.task(payload.id)?.status).toBe('completed'))
    expect(request.mock.calls.every(([, init]) => !init.method || init.method === 'GET')).toBe(true)
    expect(readFileSync(join(path, 'tasks.json'), 'utf8')).not.toContain(provider.apiKey)
    expect(await store.asset(store.task(payload.id)!.assets[0])).toMatch(/^data:image\/png;base64,/)
  })
  it('persists reusable parameters and references and removes only the selected record', async () => {
    const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: 'green' } })
      .png()
      .toBuffer()
    const reference = `data:image/png;base64,${png.toString('base64')}`
    const request = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })))
    const path = directory()
    const store = new ImageCanvasTaskStore(path, request)
    const payload = { ...input(), references: [reference], size: '1536x1024', aspectRatio: '3:2', quality: 'high' }
    store.submit(provider, payload)
    await vi.waitFor(() => expect(store.task(payload.id)?.status).toBe('completed'))
    const restored = new ImageCanvasTaskStore(path, request)
    const task = restored.task(payload.id)!
    expect(task.parameters).toMatchObject({ size: '1536x1024', aspectRatio: '3:2', quality: 'high' })
    expect(await restored.asset(task.referenceAssets![0])).toBe(reference)
    expect(readFileSync(join(path, 'tasks.json'), 'utf8')).not.toContain(reference)
    expect(readFileSync(join(path, 'tasks.json'), 'utf8')).not.toContain(provider.apiKey)
    restored.remove(task.id)
    await expect(restored.asset(task.assets[0])).rejects.toThrow('asset_unavailable')
    expect(new ImageCanvasTaskStore(path, request).history()).toEqual([])
    expect(request).toHaveBeenCalledOnce()
  })
  it('binds a recoverable task to its original credentials and never queries with a replacement key', async () => {
    const payload = input()
    const zen = { ...provider, apiHost: 'https://zenai.925636.xyz' }
    const request = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/bootstrap'))
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              submission_lookup: true,
              models: [
                {
                  id: payload.modelId,
                  protocol: 'images',
                  sizes: ['1024x1024'],
                  qualities: [],
                  backgrounds: [],
                  max_references: 4,
                  max_images: 1
                }
              ]
            }
          })
        )
      if (url.endsWith('/jobs'))
        return new Response(
          JSON.stringify({ success: true, data: { job: { state: 'succeeded' }, assets: [randomUUID()] } })
        )
      return new Response('', { status: 403 })
    })
    const store = new ImageCanvasTaskStore(directory(), request)
    store.submit(zen, payload)
    await vi.waitFor(() => expect(store.task(payload.id)?.status).toBe('uncertain'))
    const calls = request.mock.calls.length
    expect(() => store.recover({ ...zen, apiKey: 'another-account' }, payload.id)).toThrow(
      'provider_configuration_changed'
    )
    expect(request).toHaveBeenCalledTimes(calls)
    expect(request.mock.calls.filter(([url]) => url.endsWith('/jobs'))).toHaveLength(1)
  })
  it('rejects path-bearing asset records instead of using a corrupt index for cleanup', () => {
    const path = directory()
    writeFileSync(
      join(path, 'tasks.json'),
      JSON.stringify([{ ...input(), status: 'completed', assets: ['../../private'], fingerprint: 'old' }])
    )
    expect(() => new ImageCanvasTaskStore(path, vi.fn())).toThrow('invalid_task_index')
  })
  it('validates reference bytes before a generation can be billed', async () => {
    const request = vi.fn()
    const store = new ImageCanvasTaskStore(directory(), request)
    const payload = { ...input(), references: ['data:image/png;base64,iVBORw0KGgo='] }
    store.submit(provider, payload)
    await vi.waitFor(() => expect(store.task(payload.id)).toMatchObject({ status: 'failed', error: 'invalid_image' }))
    expect(request).not.toHaveBeenCalled()
  })
  it('keeps partial output visible without submitting the missing images again', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
      .png()
      .toBuffer()
    const request = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })))
    const store = new ImageCanvasTaskStore(directory(), request)
    const payload = { ...input(), count: 2 }
    store.submit(provider, payload)
    await vi.waitFor(() =>
      expect(store.task(payload.id)).toMatchObject({ status: 'uncertain', error: 'partial_image_result' })
    )
    expect(store.task(payload.id)?.assets).toHaveLength(1)
    expect(await store.asset(store.task(payload.id)!.assets[0])).toMatch(/^data:image\/png;base64,/)
    expect(request).toHaveBeenCalledOnce()
  })

  it('identifies an invalid result during decoding and keeps diagnostics isolated from credentials', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('not-an-image').toString('base64') }] }))
      )
    const path = directory()
    const store = new ImageCanvasTaskStore(path, request)
    const payload = input()
    store.submit(provider, payload)
    await vi.waitFor(() => expect(store.task(payload.id)?.status).toBe('uncertain'))
    expect(store.task(payload.id)).toMatchObject({
      error: 'invalid_result_image',
      diagnostics: { failedPhase: 'decoding', attempts: 1 }
    })
    const view = store.task(payload.id)!
    view.diagnostics!.phaseDurationsMs.decoding = -999
    expect(store.task(payload.id)?.diagnostics?.phaseDurationsMs.decoding).toBeGreaterThanOrEqual(0)
    expect(readFileSync(join(path, 'tasks.json'), 'utf8')).not.toContain(provider.apiKey)
    expect(request).toHaveBeenCalledOnce()
  })
})
