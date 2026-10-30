import type { Provider } from '@renderer/types'
import { isZenManagedApiHost } from '@shared/config/zenProvider'
import * as z from 'zod'

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const metricsSchema = z
  .object({
    input_tokens: counter,
    output_tokens: counter,
    total_tokens: counter,
    cache_tokens: counter.nullable(),
    cache_read_tokens: counter.nullable(),
    request_count: counter,
    image_request_count: counter.optional(),
    cache_known_requests: counter,
    cache_read_known_requests: counter
  })
  .refine(
    (m) =>
      m.total_tokens === m.input_tokens + m.output_tokens &&
      (m.image_request_count ?? 0) <= m.request_count &&
      m.cache_known_requests <= m.request_count - (m.image_request_count ?? 0) &&
      m.cache_read_known_requests <= m.request_count - (m.image_request_count ?? 0)
  )

const statisticsSchema = z.object({
  summary: metricsSchema,
  models: z.array(z.object({ model: z.string().max(512) }).and(metricsSchema)).max(2000),
  days: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).and(metricsSchema)).max(367)
})

export type UsageMetrics = z.infer<typeof metricsSchema>
export type UsageStatistics = z.infer<typeof statisticsSchema>
export type UsageScene = 'all' | 'chat' | 'assistant'
export type UsageSource = { id: string; label: string; apiHost: string; apiKey: string; supported: boolean }
export type UsageQuery = { start: number; end: number; timezone: string; scene: UsageScene }
export type UsageErrorCode =
  | 'unsupported'
  | 'unauthorized'
  | 'range_too_large'
  | 'timeout'
  | 'unavailable'
  | 'invalid_response'

export class UsageStatisticsError extends Error {
  constructor(public readonly code: UsageErrorCode) {
    super(code)
  }
}

// Only use explicitly configured provider credentials, never an account/admin
// token. Duplicate key entries within a provider must not double count usage.
export function getUsageSources(providers: Provider[]): UsageSource[] {
  return providers.flatMap((provider) => {
    if (
      typeof provider.apiKey !== 'string' ||
      !provider.apiKey.trim() ||
      typeof provider.apiHost !== 'string' ||
      !provider.apiHost.trim()
    )
      return []
    const keys = [
      ...new Set(
        provider.apiKey
          .split(/(?<!\\),|\r?\n/)
          .map((key) => key.trim().replace(/\\,/g, ','))
          .filter(Boolean)
      )
    ]
    return keys.map((key, index) => ({
      id: `${provider.id}:${index}`,
      label: keys.length > 1 ? `${provider.name || provider.id} · ${index + 1}` : provider.name || provider.id,
      apiHost: provider.apiHost,
      apiKey: key,
      supported: provider.type === 'new-api' || isZenManagedApiHost(provider.apiHost)
    }))
  })
}

export function buildUsageStatisticsUrl(apiHost: string, query: UsageQuery): URL {
  const host = new URL(apiHost.replace(/#$/, ''))
  if (!['http:', 'https:'].includes(host.protocol) || host.username || host.password || host.search || host.hash) {
    throw new UsageStatisticsError('unsupported')
  }
  const prefix = host.pathname.replace(/\/(?:v1|v1beta)\/?$/, '').replace(/\/$/, '')
  const url = new URL(`${prefix}/api/usage/token/statistics`, host.origin)
  url.search = new URLSearchParams({
    start_timestamp: String(query.start),
    end_timestamp: String(query.end),
    timezone: query.timezone,
    scene: query.scene
  }).toString()
  return url
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new UsageStatisticsError('invalid_response')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 2 * 1024 * 1024) {
        void reader.cancel().catch(() => undefined)
        throw new UsageStatisticsError('invalid_response')
      }
      text += decoder.decode(part.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally {
    reader.releaseLock()
  }
}

export async function fetchUsageStatistics(
  source: UsageSource,
  query: UsageQuery,
  signal: AbortSignal,
  baseFetch: typeof fetch = fetch
): Promise<UsageStatistics> {
  if (!source.supported || !source.apiKey) throw new UsageStatisticsError('unsupported')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await baseFetch(buildUsageStatisticsUrl(source.apiHost, query), {
      method: 'GET',
      signal: AbortSignal.any([signal, controller.signal]),
      headers: { Authorization: `Bearer ${source.apiKey}` },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store'
    })
    if (!response.ok) {
      if (response.status === 404 || response.status === 405) throw new UsageStatisticsError('unsupported')
      if (response.status === 401 || response.status === 403) throw new UsageStatisticsError('unauthorized')
      if (response.status === 422) throw new UsageStatisticsError('range_too_large')
      if (response.status === 504) throw new UsageStatisticsError('timeout')
      throw new UsageStatisticsError('unavailable')
    }
    const result = z
      .object({ success: z.literal(true), data: statisticsSchema })
      .safeParse(await readResponse(response))
    if (!result.success) throw new UsageStatisticsError('invalid_response')
    return result.data.data
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (controller.signal.aborted) throw new UsageStatisticsError('timeout')
    if (error instanceof UsageStatisticsError) throw error
    throw new UsageStatisticsError(error instanceof SyntaxError ? 'invalid_response' : 'unavailable')
  } finally {
    clearTimeout(timeout)
  }
}

// A cache hit means a cache READ. Cache creation is shown in the cache counter,
// but is not a hit. Missing historical metadata must never be treated as zero.
export function getCacheHitRate(metrics: UsageMetrics): number | null {
  if (
    !metrics.input_tokens ||
    metrics.request_count === (metrics.image_request_count ?? 0) ||
    metrics.cache_read_tokens === null ||
    metrics.cache_read_known_requests !== metrics.request_count - (metrics.image_request_count ?? 0) ||
    metrics.cache_read_tokens > metrics.input_tokens
  )
    return null
  return metrics.cache_read_tokens / metrics.input_tokens
}

const modelDailyQuotaSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.literal('Asia/Shanghai'),
  models: z
    .array(
      z.object({
        model: z.string(),
        limit: z.number().int().positive(),
        used: z.number().int().nonnegative(),
        reserved: z.number().int().nonnegative(),
        remaining: z.number().int().nonnegative(),
        exhausted: z.boolean()
      })
    )
    .max(200)
})
export type ModelDailyQuotaStatus = z.infer<typeof modelDailyQuotaSchema>

export async function fetchModelDailyQuota(
  source: UsageSource,
  signal: AbortSignal
): Promise<ModelDailyQuotaStatus | undefined> {
  if (!source.supported || !source.apiKey) return undefined
  const url = buildUsageStatisticsUrl(source.apiHost, { start: 0, end: 0, timezone: 'Asia/Shanghai', scene: 'all' })
  url.pathname = url.pathname.replace(/\/statistics$/, '/model-daily')
  url.search = ''
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { Authorization: `Bearer ${source.apiKey}` },
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store'
  })
  if ([404, 405].includes(response.status)) return undefined
  if (!response.ok) throw new UsageStatisticsError('unavailable')
  return z.object({ success: z.literal(true), data: modelDailyQuotaSchema }).parse(await readResponse(response)).data
}
