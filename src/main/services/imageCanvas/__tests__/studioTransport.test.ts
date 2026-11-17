import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  agent: vi.fn(),
  destroy: vi.fn(async () => {})
}))
vi.mock('undici', () => ({
  fetch: mocks.fetch,
  Agent: class {
    destroy = mocks.destroy
    constructor(options: unknown) {
      mocks.agent(options)
    }
  }
}))

import { downloadStudioAsset } from '../studioDownload'
import { createStudioDownloadFetch, studioDownloadAddressStrategy } from '../studioTransport'

const root = 'https://zenai.925636.xyz/api/image-studio'
const id = 'a'.repeat(64)
const url = `${root}/assets/${id}`
const init: RequestInit = {
  method: 'GET',
  headers: { Authorization: 'Bearer offline-test-key', 'Accept-Encoding': 'identity' },
  redirect: 'error',
  credentials: 'omit'
}

beforeEach(() => {
  mocks.fetch.mockReset()
  mocks.agent.mockClear()
  mocks.destroy.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('studio image download address selection', () => {
  it('uses IPv4 for a direct image GET while retaining the hostname and verified HTTPS', async () => {
    const fallback = vi.fn()
    mocks.fetch.mockResolvedValue(new Response('image', { headers: { 'Content-Length': '5' } }))
    const request = createStudioDownloadFetch(
      fallback,
      vi.fn(async () => 'DIRECT')
    )
    const response = await request(new URL(url), init)
    expect(await response.text()).toBe('image')
    expect(studioDownloadAddressStrategy(response)).toBe('ipv4')
    expect(mocks.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error', credentials: 'omit' }))
    expect(Object.fromEntries(mocks.fetch.mock.calls[0][1].headers).authorization).toBe('Bearer offline-test-key')
    expect(mocks.agent).toHaveBeenCalledWith({
      connect: { family: 4, timeout: 8000 },
      headersTimeout: 12000,
      bodyTimeout: 20000
    })
    expect(mocks.destroy).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back on connection failure and retries IPv4 after the cooldown', async () => {
    vi.useFakeTimers()
    const fallback = vi.fn(async () => new Response('native'))
    const request = createStudioDownloadFetch(
      fallback,
      vi.fn(async () => 'DIRECT')
    )
    mocks.fetch.mockRejectedValueOnce(new TypeError('IPv4 unavailable'))
    const response = await request(url, init)
    expect(await response.text()).toBe('native')
    expect(studioDownloadAddressStrategy(response)).toBe('default')
    await request(url, init)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(fallback).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
    mocks.fetch.mockResolvedValueOnce(new Response('ipv4'))
    expect(await (await request(url, init)).text()).toBe('ipv4')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['PROXY proxy.test:8080', 'SOCKS5 proxy.test:1080', 'DIRECT; PROXY proxy.test:8080', ''])(
    'keeps the configured proxy policy: %s',
    async (proxy) => {
      const fallback = vi.fn(async () => new Response('native'))
      const request = createStudioDownloadFetch(
        fallback,
        vi.fn(async () => proxy)
      )
      expect(await (await request(url, init)).text()).toBe('native')
      expect(mocks.fetch).not.toHaveBeenCalled()
      expect(fallback).toHaveBeenCalledWith(url, init)
    }
  )

  it('uses the native transport if proxy resolution fails', async () => {
    const fallback = vi.fn(async () => new Response('native'))
    const request = createStudioDownloadFetch(fallback, vi.fn().mockRejectedValue(new Error('proxy unavailable')))
    expect(await (await request(url, init)).text()).toBe('native')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it.each([
    [root + '/jobs', { ...init, method: 'POST', body: '{}' }],
    [root + '/assets', { ...init, method: 'POST', body: new FormData() }],
    [url, { ...init, method: 'HEAD' }],
    [root + '/bootstrap', init],
    ['https://other.test/api/image-studio/assets/' + id, init],
    ['https://zenai.925636.xyz.evil.test/api/image-studio/assets/' + id, init],
    ['http://47.103.91.113:3000/api/image-studio/assets/' + id, init],
    [url, { ...init, redirect: 'follow' }],
    [url, { ...init, credentials: 'include' }]
  ] as const)('leaves non-download and third-party requests native: %s', async (target, options) => {
    const fallback = vi.fn(async () => new Response('native'))
    const resolveProxy = vi.fn(async () => 'DIRECT')
    const request = createStudioDownloadFetch(fallback, resolveProxy)
    expect(await (await request(target, options)).text()).toBe('native')
    expect(resolveProxy).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('resumes a failed IPv4 body with the native transport and unchanged authentication', async () => {
    vi.useFakeTimers()
    const digest = createHash('sha256').update('abcdef').digest('hex')
    const responseHeaders = { ETag: '"image-v1"', 'X-Image-Bytes': '6', 'X-Image-SHA256': digest }
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('abc'))
            setTimeout(() => controller.error(new Error('interrupted')), 10)
          }
        }),
        { headers: responseHeaders }
      )
    )
    const fallback = vi.fn(
      async () =>
        new Response('def', {
          status: 206,
          headers: { ...responseHeaders, 'Content-Range': 'bytes 3-5/6', 'Content-Length': '3' }
        })
    )
    const progress = vi.fn()
    const request = createStudioDownloadFetch(
      fallback,
      vi.fn(async () => 'DIRECT')
    )
    const result = downloadStudioAsset(request, root, id, new Headers(init.headers), progress)
    await vi.advanceTimersByTimeAsync(1010)
    expect(await result).toEqual(Buffer.from('abcdef'))
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(fallback).toHaveBeenCalledOnce()
    const options = fallback.mock.calls[0][1]
    expect(options.headers.get('Range')).toBe('bytes=3-')
    expect(options.headers.get('If-Range')).toBe('"image-v1"')
    expect(options.headers.get('Authorization')).toBe('Bearer offline-test-key')
    expect(progress.mock.lastCall?.[0].history).toMatchObject([
      { addressStrategy: 'ipv4', reason: 'network' },
      { addressStrategy: 'default', offset: 3 }
    ])
  })

  it('does not fall back or resubmit a request rejected by the API', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
    const fallback = vi.fn()
    const request = createStudioDownloadFetch(
      fallback,
      vi.fn(async () => 'DIRECT')
    )
    await expect(downloadStudioAsset(request, root, id, new Headers(init.headers), vi.fn())).rejects.toThrow(
      'studio_download_failed'
    )
    expect(fallback).not.toHaveBeenCalled()
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it('aborts a stalled body, closes its connection and resumes on the native path', async () => {
    vi.useFakeTimers()
    mocks.fetch.mockResolvedValueOnce(new Response(new ReadableStream()))
    const fallback = vi.fn(async () => new Response('image'))
    const request = createStudioDownloadFetch(
      fallback,
      vi.fn(async () => 'DIRECT')
    )
    const result = downloadStudioAsset(request, root, id, new Headers(init.headers), vi.fn())
    await vi.advanceTimersByTimeAsync(31000)
    expect(await result).toEqual(Buffer.from('image'))
    expect(mocks.destroy).toHaveBeenCalledOnce()
    expect(fallback).toHaveBeenCalledOnce()
  })
})
