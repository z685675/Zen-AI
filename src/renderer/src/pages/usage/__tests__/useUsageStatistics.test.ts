import type { UsageSource, UsageStatistics } from '@renderer/services/UsageStatisticsService'
import type * as UsageModule from '@renderer/services/UsageStatisticsService'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyUsageMetrics } from '../usageUtils'
import { useUsageStatistics } from '../useUsageStatistics'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@renderer/services/UsageStatisticsService', async (original) => ({
  ...(await original<typeof UsageModule>()),
  fetchUsageStatistics: mocks.fetch
}))
const source: UsageSource = {
  id: 'zen:0',
  label: 'Zen API',
  apiHost: 'https://test.invalid',
  apiKey: 'fake-key',
  supported: true
}
const query = { start: 100, end: 200, timezone: 'Asia/Shanghai', scene: 'all' as const }
const result: UsageStatistics = {
  summary: { ...emptyUsageMetrics(), input_tokens: 123, total_tokens: 123 },
  models: [],
  days: []
}

describe('usage loading isolation', () => {
  beforeEach(() => {
    mocks.fetch.mockReset()
  })
  it('cancels old requests and ignores a late result after the selected key changes', async () => {
    let resolveFirst: ((value: UsageStatistics) => void) | undefined
    mocks.fetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce({ ...result, summary: { ...result.summary, input_tokens: 456, total_tokens: 456 } })
    const hook = renderHook(({ current }) => useUsageStatistics(current, query, 0), {
      initialProps: { current: source }
    })
    const firstSignal = mocks.fetch.mock.calls[0][2] as AbortSignal
    hook.rerender({ current: { ...source, apiKey: 'second-key' } })
    expect(firstSignal.aborted).toBe(true)
    await waitFor(() => expect(hook.result.current.stats?.summary.input_tokens).toBe(456))
    await act(async () => resolveFirst?.(result))
    expect(hook.result.current.stats?.summary.input_tokens).toBe(456)
  })
  it('clears results on a date/scene refresh and aborts on unmount', async () => {
    mocks.fetch.mockResolvedValueOnce(result).mockImplementation(() => new Promise(() => undefined))
    const hook = renderHook(({ revision, start }) => useUsageStatistics(source, { ...query, start }, revision), {
      initialProps: { revision: 0, start: 100 }
    })
    await waitFor(() => expect(hook.result.current.stats).toEqual(result))
    hook.rerender({ revision: 1, start: 101 })
    expect(hook.result.current.stats).toBeNull()
    expect(hook.result.current.loading).toBe(true)
    const signal = mocks.fetch.mock.calls[1][2] as AbortSignal
    hook.unmount()
    expect(signal.aborted).toBe(true)
  })
  it('does not query unsupported services or a missing provider', () => {
    const hook = renderHook(() => useUsageStatistics({ ...source, supported: false }, query, 0))
    expect(hook.result.current.error).toBe('unsupported')
    expect(mocks.fetch).not.toHaveBeenCalled()
    hook.unmount()
    const missing = renderHook(() => useUsageStatistics(undefined, query, 0))
    expect(missing.result.current.loading).toBe(false)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('does not turn errors into an empty successful result', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('failed'))
    const hook = renderHook(() => useUsageStatistics(source, query, 0))
    await waitFor(() => expect(hook.result.current.error).toBe('unavailable'))
    expect(hook.result.current.stats).toBeNull()
    expect(hook.result.current.loading).toBe(false)
  })
})
