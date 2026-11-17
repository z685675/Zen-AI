import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn(), agent: {} }))
vi.mock('undici', () => ({ fetch: mocks.send }))
vi.mock('../connection', () => ({
  ModelConnectionPool: class {
    agent = mocks.agent
    run(_record: unknown, send: () => unknown) {
      return send()
    }
    destroy = mocks.destroy
  }
}))

import { ModelApiTransport } from '../transport'

afterEach(() => vi.clearAllMocks())
const url = 'https://zenai.925636.xyz/v1/chat/completions'
const options = { method: 'POST', headers: { Authorization: 'Bearer PRIVATE_KEY' }, body: 'PRIVATE_PROMPT' }

describe('managed model connection transport', () => {
  it('keeps the HTTPS hostname, exact request and signal on a private IPv4-preferred dispatcher', async () => {
    const service = new ModelApiTransport()
    service.resolveProxy = vi.fn().mockResolvedValue('DIRECT')
    const response = new Response('data: ok\n\n')
    mocks.send.mockResolvedValue(response)
    const native = vi.fn()
    const record = vi.fn()
    const signal = new AbortController().signal
    expect(await service.fetch(url, { ...options, signal }, record, native)).toBe(response)
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(url, {
      ...options,
      headers: [['authorization', 'Bearer PRIVATE_KEY']],
      signal,
      dispatcher: mocks.agent
    })
    expect(native).not.toHaveBeenCalled()
    expect(JSON.stringify(record.mock.calls)).not.toMatch(/PRIVATE_KEY|PRIVATE_PROMPT/)
    await service.destroy()
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })

  it.each(['PROXY 127.0.0.1:7890', 'SOCKS5 127.0.0.1:7890', 'PROXY proxy:80; DIRECT', ''])(
    'preserves native proxy handling for %s',
    async (proxy) => {
      const service = new ModelApiTransport()
      service.resolveProxy = vi.fn().mockResolvedValue(proxy)
      const native = vi.fn().mockResolvedValue(new Response('ok'))
      await service.fetch(url, options, undefined, native)
      expect(native).toHaveBeenCalledExactlyOnceWith(url, options)
      expect(mocks.send).not.toHaveBeenCalled()
    }
  )

  it('preserves native behavior when proxy resolution fails or initialization has not run', async () => {
    const service = new ModelApiTransport()
    const native = vi.fn().mockResolvedValue(new Response('ok'))
    await service.fetch(url, options, undefined, native)
    service.resolveProxy = vi.fn().mockRejectedValue(new Error('unknown proxy'))
    await service.fetch(url, options, undefined, native)
    expect(native).toHaveBeenCalledTimes(2)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it.each([
    'https://other.example/v1/chat/completions',
    'http://47.103.91.113:3000/v1/chat/completions',
    'https://zenai.925636.xyz/api/image-studio/tasks',
    'https://zenai.925636.xyz.evil.example/v1/chat/completions'
  ])('does not alter unrelated request %s', async (target) => {
    const service = new ModelApiTransport()
    service.resolveProxy = vi.fn()
    const native = vi.fn().mockResolvedValue(new Response('ok'))
    await service.fetch(target, options, undefined, native)
    expect(native).toHaveBeenCalledExactlyOnceWith(target, options)
    expect(service.resolveProxy).not.toHaveBeenCalled()
  })

  it('never replays a failed generation, even when no headers were received', async () => {
    const service = new ModelApiTransport()
    service.resolveProxy = vi.fn().mockResolvedValue('DIRECT')
    const error = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    mocks.send.mockRejectedValue(error)
    const native = vi.fn()
    const record = vi.fn()
    await expect(service.fetch(url, options, record, native)).rejects.toBe(error)
    expect(mocks.send).toHaveBeenCalledOnce()
    expect(native).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith('connection-request-failed', {
      error: { name: 'TypeError', message: 'fetch failed', code: 'ECONNRESET' }
    })
  })

  it('does not resend an HTTP error or create a request after cancellation during proxy resolution', async () => {
    const service = new ModelApiTransport()
    const controller = new AbortController()
    service.resolveProxy = async () => {
      controller.abort()
      return 'DIRECT'
    }
    await expect(service.fetch(url, { ...options, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(mocks.send).not.toHaveBeenCalled()
    service.resolveProxy = async () => 'DIRECT'
    const response = new Response('unavailable', { status: 503 })
    mocks.send.mockResolvedValue(response)
    expect(await service.fetch(url, options)).toBe(response)
    expect(mocks.send).toHaveBeenCalledOnce()
  })
})
