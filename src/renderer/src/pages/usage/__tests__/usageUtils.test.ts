import type { UsageStatistics } from '@renderer/services/UsageStatisticsService'
import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'

import { emptyUsageMetrics, getUsageRange, groupUsageDays } from '../usageUtils'

describe('usage date ranges and buckets', () => {
  const now = dayjs('2026-10-15T12:00:00')
  it.each([
    ['today', '2026-10-15'],
    ['week', '2026-10-12'],
    ['month', '2026-10-01'],
    ['last7', '2026-10-09'],
    ['last30', '2026-09-16']
  ] as const)('calculates %s as full local days', (period, first) => {
    const [start, end] = getUsageRange(period, now)
    expect(start.format('YYYY-MM-DD HH:mm:ss')).toBe(`${first} 00:00:00`)
    expect(end.format('YYYY-MM-DD HH:mm:ss')).toBe('2026-10-15 23:59:59')
  })
  it('treats Sunday as the last day of the week', () => {
    expect(getUsageRange('week', dayjs('2026-10-18'))[0].format('YYYY-MM-DD')).toBe('2026-10-12')
  })
  it('zero-fills missing days while retaining unknown cache data on actual records', () => {
    const days: UsageStatistics['days'] = [
      { ...emptyUsageMetrics(), date: '2026-10-01', input_tokens: 100, total_tokens: 100, request_count: 1 },
      {
        ...emptyUsageMetrics(),
        date: '2026-10-03',
        input_tokens: 200,
        output_tokens: 20,
        total_tokens: 220,
        request_count: 1,
        cache_tokens: 180,
        cache_read_tokens: 180,
        cache_known_requests: 1,
        cache_read_known_requests: 1
      }
    ]
    const daily = groupUsageDays(days, dayjs('2026-10-01'), dayjs('2026-10-03'), 'day')
    expect(daily).toHaveLength(3)
    expect(daily[0]).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-01' })
    expect(daily[1].request_count).toBe(0)
    expect(daily[0].cache_tokens).toBeNull()
    for (const interval of ['week', 'month'] as const) {
      const [bucket] = groupUsageDays(days, dayjs('2026-10-01'), dayjs('2026-10-03'), interval)
      expect(bucket).toMatchObject({
        startDate: '2026-10-01',
        endDate: '2026-10-03',
        input_tokens: 300,
        output_tokens: 20,
        total_tokens: 320,
        cache_tokens: 180,
        request_count: 2,
        cache_known_requests: 1
      })
    }
  })
  it('does not mix dates outside the selected range into grouped totals', () => {
    const grouped = groupUsageDays(
      [{ ...emptyUsageMetrics(), date: '2026-09-30', input_tokens: 100 }],
      dayjs('2026-10-01'),
      dayjs('2026-10-01'),
      'month'
    )
    expect(grouped[0].input_tokens).toBe(0)
  })
})
