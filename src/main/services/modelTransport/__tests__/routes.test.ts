import { CLIENT_CONNECTION_ORIGIN as CF, type ClientConnectionPolicy } from '@shared/clientConnections'
import { describe, expect, it, vi } from 'vitest'

import { ClientConnectionRouter } from '../routes'

const IP = 'https://47.103.91.113'
const policy: ClientConnectionPolicy = {
  schemaVersion: 1,
  version: 2,
  mode: 'auto',
  directOrigin: IP,
  fallbackOrigin: CF,
  deploymentId: 'a'.repeat(32),
  updatedAt: '2026-11-17T00:00:00Z'
}
const json = (data: unknown) => new Response(JSON.stringify(data))
function setup(cached: unknown = policy) {
  let time = 1000
  let current = policy
  const check = vi.fn(async () => json({ schemaVersion: 1, deploymentId: policy.deploymentId }))
  const metadata = vi.fn(async (url: RequestInfo | URL) =>
    String(url).endsWith('/connections') ? json({ data: current }) : check()
  )
  const save = vi.fn()
  const router = new ClientConnectionRouter({ fetch: metadata, load: () => cached, save, now: () => time })
  const send = vi.fn<typeof fetch>(async () => new Response('answer'))
  return {
    router,
    send,
    check,
    metadata,
    save,
    advance: (ms: number) => {
      time += ms
    },
    publish: (p: ClientConnectionPolicy) => {
      current = p
    }
  }
}
const url = CF + '/v1/chat/completions'
const options = { method: 'POST', body: 'prompt', headers: { Authorization: 'Bearer secret' } }

describe('centrally managed client connection routes', () => {
  it('keeps the logical provider unchanged and sends once to a verified HTTPS IP', async () => {
    const s = setup()
    const record = vi.fn()
    expect(await (await s.router.fetch(url, options, s.send, record)).text()).toBe('answer')
    expect(s.send).toHaveBeenCalledExactlyOnceWith(IP + '/v1/chat/completions', expect.objectContaining(options))
    expect(s.check).toHaveBeenCalledOnce()
    expect(JSON.stringify(s.metadata.mock.calls)).not.toContain('secret')
    expect(record).toHaveBeenCalledWith('connection-route', expect.objectContaining({ route: 'ip-direct', origin: IP }))
  })

  it('falls back before POST submission if the identity check fails', async () => {
    const s = setup()
    s.check.mockResolvedValue(json({ deploymentId: 'wrong' }))
    await s.router.fetch(url, options, s.send)
    expect(s.send).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining(options))
  })

  it('does not replay a submitted POST and uses CF on the next request', async () => {
    const s = setup()
    s.send.mockRejectedValueOnce(new Error('socket reset'))
    await expect(s.router.fetch(url, options, s.send)).rejects.toThrow('socket reset')
    expect(s.send).toHaveBeenCalledOnce()
    await s.router.fetch(url, options, s.send)
    expect(s.send.mock.calls[1][0]).toBe(url)
  })

  it('surfaces a midstream error, preserves partial bytes and marks direct unhealthy', async () => {
    const s = setup()
    let stream!: ReadableStreamDefaultController<Uint8Array>
    s.send.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(c) {
            stream = c
          }
        })
      )
    )
    const response = await s.router.fetch(url, options, s.send)
    const reader = response.body!.getReader()
    stream.enqueue(new TextEncoder().encode('partial'))
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('partial')
    stream.error(new Error('broken connection'))
    await expect(reader.read()).rejects.toThrow('broken connection')
    expect(s.send).toHaveBeenCalledOnce()
    await s.router.fetch(url, options, s.send)
    expect(s.send.mock.calls[1][0]).toBe(url)
  })

  it('requires two spaced successes after cooldown before returning to direct', async () => {
    const s = setup()
    s.check.mockRejectedValueOnce(new Error('offline'))
    await s.router.fetch(url, options, s.send)
    s.advance(120_001)
    await s.router.fetch(url, options, s.send)
    expect(s.send.mock.calls[1][0]).toBe(url)
    s.advance(30_001)
    await s.router.fetch(url, options, s.send)
    expect(s.send.mock.calls[2][0]).toBe(IP + '/v1/chat/completions')
  })

  it('accepts forced CF and discovers a changed IP through the stable domain', async () => {
    const s = setup()
    s.publish({ ...policy, version: 3, mode: 'cloudflare' })
    await s.router.refresh()
    await s.router.fetch(url, options, s.send)
    expect(s.send.mock.calls[0][0]).toBe(url)
    s.advance(60_001)
    s.publish({ ...policy, version: 4, directOrigin: 'https://8.8.4.4' })
    await s.router.refresh()
    await s.router.fetch(url, options, s.send)
    expect(s.send.mock.calls[1][0]).toBe('https://8.8.4.4/v1/chat/completions')
    expect(s.metadata.mock.calls[0][0]).toBe(CF + '/api/client/connections')
  })

  it('uses its cache during a policy outage and rejects private origins and version rollback', async () => {
    const s = setup()
    s.metadata.mockRejectedValueOnce(new Error('CF offline'))
    await s.router.refresh()
    await s.router.fetch(url, options, s.send)
    expect(s.send.mock.calls[0][0]).toBe(IP + '/v1/chat/completions')
    s.advance(60_001)
    s.publish({ ...policy, version: 9, directOrigin: 'https://127.0.0.1' })
    await s.router.refresh()
    s.advance(60_001)
    s.publish({ ...policy, version: 1, mode: 'cloudflare' })
    await s.router.refresh()
    expect(s.save).not.toHaveBeenCalled()
  })

  it('does not change browser sites, download origins, third-party APIs or input Requests', async () => {
    const s = setup()
    for (const target of [
      'https://example.com/v1/chat/completions',
      'https://download.925636.xyz/app.exe',
      CF + '/admin'
    ]) {
      await s.router.fetch(target, undefined, s.send)
      expect(s.send).toHaveBeenLastCalledWith(target, undefined)
    }
    expect(s.metadata).not.toHaveBeenCalled()
  })

  it('does not submit after cancellation while waiting for a health check', async () => {
    const s = setup()
    const controller = new AbortController()
    s.check.mockImplementationOnce(async () => {
      controller.abort()
      return json({ schemaVersion: 1, deploymentId: policy.deploymentId })
    })
    await expect(s.router.fetch(url, { ...options, signal: controller.signal }, s.send)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(s.send).not.toHaveBeenCalled()
  })

  it('preserves image resume headers and reads an existing job after direct failure', async () => {
    const s = setup()
    s.send.mockRejectedValueOnce(new Error('download disconnected'))
    const asset = CF + '/api/image-studio/assets/' + 'f'.repeat(64)
    const headers = { Authorization: 'Bearer secret', Range: 'bytes=123-', 'If-Range': 'immutable-etag' }
    await expect(s.router.fetch(asset, { headers }, s.send)).rejects.toThrow('download disconnected')
    await s.router.fetch(asset, { headers }, s.send)
    expect(s.send.mock.calls[1]).toEqual([asset, expect.objectContaining({ headers })])
    await s.router.fetch(CF + '/api/image-studio/jobs/by-submission/task-123', undefined, s.send)
    expect(String(s.send.mock.calls[2][0])).toContain(CF + '/api/image-studio/jobs/')
    expect(s.send.mock.calls.every(([, init]) => !init?.body)).toBe(true)
  })

  it('does not mark a user-cancelled stream as an unhealthy route', async () => {
    const s = setup()
    const controller = new AbortController()
    let stream!: ReadableStreamDefaultController<Uint8Array>
    s.send.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(c) {
            stream = c
          }
        })
      )
    )
    const response = await s.router.fetch(url, { ...options, signal: controller.signal }, s.send)
    controller.abort()
    stream.error(controller.signal.reason)
    await expect(response.text()).rejects.toMatchObject({ name: 'AbortError' })
    await s.router.fetch(url, options, s.send)
    expect(s.send.mock.calls[1][0]).toBe(IP + '/v1/chat/completions')
  })

  it('marks a stalled download timeout as a route failure even when its reader is cancelled', async () => {
    const s = setup()
    const controller = new AbortController()
    s.send.mockResolvedValueOnce(new Response(new ReadableStream({})))
    const asset = CF + '/api/image-studio/assets/' + 'a'.repeat(64)
    const response = await s.router.fetch(asset, { signal: controller.signal }, s.send)
    controller.abort(new DOMException('idle-timeout', 'TimeoutError'))
    await response.body!.cancel()
    await s.router.fetch(asset, undefined, s.send)
    expect(s.send.mock.calls[1][0]).toBe(asset)
  })
})
