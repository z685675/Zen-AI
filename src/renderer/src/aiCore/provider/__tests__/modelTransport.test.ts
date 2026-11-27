import type { ModelTransportBridge, ModelTransportStart } from '@shared/modelTransport'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { managedModelFetch } from '../modelTransport'

const url = 'https://zenai.925636.xyz/v1/chat/completions'
const options = { method: 'POST', headers: { Authorization: 'Bearer private-key' }, body: 'original-input' }
const encoder = new TextEncoder()
function bridge() {
  return {
    start: vi.fn<ModelTransportBridge['start']>().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      hasBody: true,
      headers: [
        ['content-type', 'text/event-stream'],
        ['x-oneapi-request-id', 'request-1']
      ]
    }),
    pull: vi.fn<ModelTransportBridge['pull']>(),
    cancel: vi.fn<ModelTransportBridge['cancel']>().mockResolvedValue(undefined)
  }
}
afterEach(() => vi.useRealTimers())

describe('AI chat streaming transport', () => {
  it('preserves the prompt, credentials, server ID and individual SSE chunks', async () => {
    const api = bridge()
    api.pull
      .mockResolvedValueOnce({ done: false, value: encoder.encode('data: 你好\n\n') })
      .mockResolvedValueOnce({ done: false, value: encoder.encode('data: [DONE]\n\n') })
      .mockResolvedValueOnce({ done: true })
    const native = vi.fn()
    const response = await managedModelFetch(native, () => api)(url, options)
    expect(api.start).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String),
      url,
      method: 'POST',
      headers: [['authorization', 'Bearer private-key']],
      body: 'original-input'
    })
    expect(response.headers.get('x-oneapi-request-id')).toBe('request-1')
    expect(api.pull).not.toHaveBeenCalled()
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 你好\n\n')
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: [DONE]\n\n')
    expect((await reader.read()).done).toBe(true)
    expect(native).not.toHaveBeenCalled()
  })

  it('never replays a generation if bridge start fails or the response stream breaks', async () => {
    const api = bridge()
    const native = vi.fn()
    const send = managedModelFetch(native, () => api)
    api.start.mockResolvedValueOnce({
      ok: false,
      error: { name: 'TypeError', message: 'fetch failed', code: 'ECONNRESET' }
    })
    await expect(send(url, options)).rejects.toMatchObject({ message: 'fetch failed', code: 'ECONNRESET' })
    expect(api.start).toHaveBeenCalledOnce()
    expect(native).not.toHaveBeenCalled()
    api.pull
      .mockResolvedValueOnce({ done: false, value: encoder.encode('partial answer') })
      .mockResolvedValueOnce({ error: { name: 'TypeError', message: 'stream interrupted' } })
    const response = await send(url, options)
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    await expect(reader.read()).rejects.toThrow('stream interrupted')
    expect(api.start).toHaveBeenCalledTimes(2)
    expect(native).not.toHaveBeenCalled()
  })

  it('cancels while waiting for response headers, without submitting again', async () => {
    const api = bridge()
    let resolve!: (value: ModelTransportStart) => void
    api.start.mockImplementation(
      () =>
        new Promise((ready) => {
          resolve = ready
        })
    )
    const controller = new AbortController()
    const send = managedModelFetch(vi.fn(), () => api)
    const pending = send(url, { ...options, signal: controller.signal })
    const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    resolve({ ok: false, error: { name: 'AbortError', message: 'aborted' } })
    await result
    expect(api.start).toHaveBeenCalledOnce()
    expect(api.cancel).toHaveBeenCalledWith(api.start.mock.calls[0][0].id)
  })

  it('aborts an active stream and releases it when the reader cancels', async () => {
    const api = bridge()
    const controller = new AbortController()
    const send = managedModelFetch(vi.fn(), () => api)
    const response = await send(url, { ...options, signal: controller.signal })
    const reader = response.body!.getReader()
    controller.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.cancel).toHaveBeenCalledWith(api.start.mock.calls[0][0].id)
    const second = await send(url, options)
    await second.body!.cancel()
    expect(api.cancel).toHaveBeenCalledWith(api.start.mock.calls[1][0].id)
  })

  it('sends the timeout category across IPC when the caller deadline expires', async () => {
    const api = bridge()
    const controller = new AbortController()
    const response = await managedModelFetch(vi.fn(), () => api)(url, { ...options, signal: controller.signal })
    controller.abort(new DOMException('deadline reached', 'TimeoutError'))
    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith(api.start.mock.calls[0][0].id, 'timeout')
  })

  it('does not apply image timeouts while a complex model is still reasoning', async () => {
    vi.useFakeTimers()
    const api = bridge()
    let resolve!: (value: ModelTransportStart) => void
    api.start.mockImplementation(
      () =>
        new Promise((ready) => {
          resolve = ready
        })
    )
    const pending = managedModelFetch(vi.fn(), () => api)(url, options)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(api.cancel).not.toHaveBeenCalled()
    resolve({ ok: true, status: 204, statusText: 'No Content', headers: [], hasBody: false })
    expect((await pending).status).toBe(204)
    expect(api.start).toHaveBeenCalledOnce()
  })

  it.each([
    ['https://third-party.example/v1/chat/completions', options],
    ['https://zenai.925636.xyz/api/image-studio/tasks', options],
    [url, { ...options, body: new FormData() }],
    [url, { ...options, credentials: 'include' as const }]
  ])('preserves the existing path for unsupported request %s', async (target, init) => {
    const api = bridge()
    const native = vi.fn().mockResolvedValue(new Response('native'))
    expect(await managedModelFetch(native, () => api)(target, init)).toBeInstanceOf(Response)
    expect(native).toHaveBeenCalledExactlyOnceWith(target, init)
    expect(api.start).not.toHaveBeenCalled()
  })

  it('supports an older preload without a bridge', async () => {
    const native = vi.fn().mockResolvedValue(new Response('native'))
    await managedModelFetch(native, () => undefined)(url, options)
    expect(native).toHaveBeenCalledExactlyOnceWith(url, options)
  })
})
