import type { UsageMetrics, UsageStatistics } from '@renderer/services/UsageStatisticsService'
import dayjs from 'dayjs'

export type UsagePeriod = 'today' | 'week' | 'month' | 'last7' | 'last30' | 'custom'
export type UsageInterval = 'day' | 'week' | 'month'
export type UsageTrendBucket = UsageStatistics['days'][number] & { startDate: string; endDate: string }

export function getUsageRange(period: Exclude<UsagePeriod, 'custom'>, now = dayjs()): [dayjs.Dayjs, dayjs.Dayjs] {
  const end = now.endOf('day')
  if (period === 'today') return [now.startOf('day'), end]
  if (period === 'week') return [now.subtract((now.day() + 6) % 7, 'day').startOf('day'), end]
  if (period === 'month') return [now.startOf('month'), end]
  return [now.subtract(period === 'last7' ? 6 : 29, 'day').startOf('day'), end]
}

export function emptyUsageMetrics(): UsageMetrics {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_tokens: null,
    cache_read_tokens: null,
    request_count: 0,
    image_request_count: 0,
    cache_known_requests: 0,
    cache_read_known_requests: 0
  }
}

export function groupUsageDays(
  days: UsageStatistics['days'],
  start: dayjs.Dayjs,
  end: dayjs.Dayjs,
  interval: UsageInterval
): UsageTrendBucket[] {
  const buckets = new Map<string, UsageTrendBucket>()
  const lookup = new Map(days.map((day) => [day.date, day]))
  for (let date = start.startOf('day'); !date.isAfter(end, 'day'); date = date.add(1, 'day')) {
    const currentDate = date.format('YYYY-MM-DD')
    let key = currentDate
    if (interval === 'week') key = date.subtract((date.day() + 6) % 7, 'day').format('YYYY-MM-DD')
    if (interval === 'month') key = date.format('YYYY-MM')
    const bucket = buckets.get(key) ?? {
      date: key,
      startDate: currentDate,
      endDate: currentDate,
      ...emptyUsageMetrics()
    }
    bucket.endDate = currentDate
    const day = lookup.get(currentDate)
    if (day) {
      bucket.input_tokens += day.input_tokens
      bucket.output_tokens += day.output_tokens
      bucket.total_tokens += day.total_tokens
      bucket.request_count += day.request_count
      bucket.image_request_count = (bucket.image_request_count ?? 0) + (day.image_request_count ?? 0)
      bucket.cache_known_requests += day.cache_known_requests
      bucket.cache_read_known_requests += day.cache_read_known_requests
      if (day.cache_tokens !== null) bucket.cache_tokens = (bucket.cache_tokens ?? 0) + day.cache_tokens
      if (day.cache_read_tokens !== null)
        bucket.cache_read_tokens = (bucket.cache_read_tokens ?? 0) + day.cache_read_tokens
    }
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
}
