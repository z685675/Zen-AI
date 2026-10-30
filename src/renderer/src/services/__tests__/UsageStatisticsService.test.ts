import type { Provider } from '@renderer/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildUsageStatisticsUrl,
  fetchModelDailyQuota,
  fetchUsageStatistics,
  getCacheHitRate,
  getUsageSources,
  type UsageMetrics,
  type UsageSource
} from '../UsageStatisticsService'

afterEach(() => vi.restoreAllMocks())

describe('personal model daily allowances', () => {
  it('queries the current day independently of historical ranges and tolerates old servers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            date: '2026-10-24',
            timezone: 'Asia/Shanghai',
            models: [{ model: 'premium', limit: 100, used: 140, remaining: 0, reserved: 0, exhausted: true }]
          }
        })
      )
    )
    const result = await fetchModelDailyQuota(source, new AbortController().signal)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://test.invalid/api/usage/token/model-daily')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer fake-secret' },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store'
    })
    expect(result?.models[0].exhausted).toBe(true)
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    expect(await fetchModelDailyQuota(source, new AbortController().signal)).toBeUndefined()
  })
})

const metrics: UsageMetrics = {
  input_tokens: 130000,
  output_tokens: 1000,
  total_tokens: 131000,
  cache_tokens: 120000,
  cache_read_tokens: 100000,
  request_count: 2,
  cache_known_requests: 2,
  cache_read_known_requests: 2
}
const source: UsageSource = {
  id: 'test:0',
  label: 'Test API',
  apiHost: 'https://test.invalid/v1',
  apiKey: 'fake-secret',
  supported: true
}
const query = { start: 100, end: 200, timezone: 'Asia/Shanghai', scene: 'all' as const }
const response = () =>
  new Response(
    JSON.stringify({
      success: true,
      data: {
        summary: metrics,
        models: [{ model: 'gpt-test', ...metrics }],
        days: [{ date: '2026-10-01', ...metrics }]
      }
    })
  )

describe('server-backed usage statistics', () => {
  it('makes a read-only query with a configured key, without model calls or key URL parameters', async () => {
    const fetcher = vi.fn(async () => response())
    const result = await fetchUsageStatistics(source, query, new AbortController().signal, fetcher)
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.pathname).toBe('/api/usage/token/statistics')
    expect(url.searchParams.get('timezone')).toBe('Asia/Shanghai')
    expect(String(url)).not.toContain('fake-secret')
    expect(options.method).toBe('GET')
    expect(options.body).toBeUndefined()
    expect(options.credentials).toBe('omit')
    expect(options.redirect).toBe('error')
    expect(options.headers).toEqual({ Authorization: 'Bearer fake-secret' })
    expect(result.summary).toEqual(metrics)
    expect(result.summary.total_tokens).toBe(131000) // not input + output + cache
    expect(JSON.stringify(result)).not.toContain('fake-secret')
  })
  it('preserves a reverse-proxy prefix and supports local test panels', () => {
    expect(buildUsageStatisticsUrl('http://localhost:3000/proxy/v1/', query).pathname).toBe(
      '/proxy/api/usage/token/statistics'
    )
    expect(buildUsageStatisticsUrl('https://test.invalid/v1#', query).pathname).toBe('/api/usage/token/statistics')
    expect(() => buildUsageStatisticsUrl('https://user:password@test.invalid/v1', query)).toThrow()
    expect(() => buildUsageStatisticsUrl('file:///tmp', query)).toThrow()
  })
  it.each([
    [404, 'unsupported'],
    [405, 'unsupported'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [422, 'range_too_large'],
    [504, 'timeout'],
    [500, 'unavailable']
  ])('handles HTTP %s without inventing zero usage', async (status, code) => {
    await expect(
      fetchUsageStatistics(
        source,
        query,
        new AbortController().signal,
        async () => new Response('', { status: Number(status) })
      )
    ).rejects.toMatchObject({ code })
  })
  it('rejects invalid, missing or oversized responses', async () => {
    for (const body of [
      'not json',
      '{}',
      JSON.stringify({ success: true, data: { summary: { ...metrics, total_tokens: 251000 }, models: [], days: [] } }),
      ' '.repeat(2 * 1024 * 1024 + 1)
    ]) {
      await expect(
        fetchUsageStatistics(source, query, new AbortController().signal, async () => new Response(body))
      ).rejects.toMatchObject({ code: 'invalid_response' })
    }
  })
  it('does not send unsupported provider credentials anywhere', async () => {
    const fetcher = vi.fn()
    await expect(
      fetchUsageStatistics({ ...source, supported: false }, query, new AbortController().signal, fetcher)
    ).rejects.toMatchObject({ code: 'unsupported' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('bounds the wait and supports cancellation', async () => {
    vi.useFakeTimers()
    try {
      const fetcher: typeof fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      const timedOut = fetchUsageStatistics(source, query, new AbortController().signal, fetcher)
      const timeoutAssertion = expect(timedOut).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(15000)
      await timeoutAssertion
      const controller = new AbortController()
      const cancelled = fetchUsageStatistics(source, query, controller.signal, fetcher)
      const cancellationAssertion = expect(cancelled).rejects.toBe('cancelled')
      controller.abort('cancelled')
      await cancellationAssertion
    } finally {
      vi.useRealTimers()
    }
  })
  it('splits keys without exposing them in labels and supports disabled providers for history', () => {
    const sources = getUsageSources([
      {
        id: 'zen',
        name: 'Zen API',
        type: 'new-api',
        enabled: false,
        apiHost: 'https://test.invalid/v1',
        apiKey: 'key-a,key-a\nkey-b',
        models: []
      } as Provider
    ])
    expect(sources.map((item) => item.label)).toEqual(['Zen API · 1', 'Zen API · 2'])
    expect(sources.map((item) => item.apiKey)).toEqual(['key-a', 'key-b'])
    expect(sources.every((item) => item.supported)).toBe(true)
  })
  it('does not count cache writes as cache hits or unknown metadata as a zero', () => {
    expect(getCacheHitRate(metrics)).toBeCloseTo(100000 / 130000)
    expect(getCacheHitRate({ ...metrics, cache_read_known_requests: 1 })).toBeNull()
    expect(getCacheHitRate({ ...metrics, cache_read_tokens: null })).toBeNull()
    expect(getCacheHitRate({ ...metrics, input_tokens: 0 })).toBeNull()
    expect(getCacheHitRate({ ...metrics, cache_read_tokens: 0 })).toBe(0)
    expect(getCacheHitRate({ ...metrics, request_count: 5, image_request_count: 3 })).toBeCloseTo(100000 / 130000)
  })
  it('reads image counts independently of tokens and rejects impossible image totals', async () => {
    const imageMetrics = {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cache_tokens: null,
      cache_read_tokens: null,
      request_count: 3,
      image_request_count: 3,
      cache_known_requests: 0,
      cache_read_known_requests: 0
    }
    const fetcher = (imageCount: number) => async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            summary: { ...imageMetrics, image_request_count: imageCount },
            models: [{ model: 'gpt-image-1', ...imageMetrics }],
            days: [{ date: '2026-10-01', ...imageMetrics }]
          }
        })
      )
    const result = await fetchUsageStatistics(source, query, new AbortController().signal, fetcher(3))
    expect(result.summary.image_request_count).toBe(3)
    expect(result.models[0].total_tokens).toBe(0)
    expect(result.days[0].image_request_count).toBe(3)
    expect(getCacheHitRate(result.summary)).toBeNull()
    await expect(fetchUsageStatistics(source, query, new AbortController().signal, fetcher(4))).rejects.toMatchObject({
      code: 'invalid_response'
    })
  })
  it('tolerates incomplete imported providers and a fresh installation', () => {
    expect(getUsageSources([])).toEqual([])
    expect(
      getUsageSources([
        { id: 'missing-key', apiHost: 'https://test.invalid' },
        { id: 'missing-host', apiKey: 'fake-key' },
        { id: 'empty-key', apiHost: 'https://test.invalid', apiKey: ' , \n ' }
      ] as Provider[])
    ).toEqual([])
  })
})
