export type ModelDailyQuotaErrorKind = 'exceeded' | 'pending' | 'invalid' | 'unavailable'
export const MODEL_DAILY_QUOTA_MESSAGE_KEYS = {
  exceeded: 'model_daily_quota.exceeded',
  pending: 'model_daily_quota.pending',
  invalid: 'model_daily_quota.invalid',
  unavailable: 'model_daily_quota.unavailable'
} as const

/** Recognize SDK-wrapped errors without relying on a generic HTTP 403/429. */
export function getModelDailyQuotaErrorKind(error: unknown): ModelDailyQuotaErrorKind | undefined {
  const visited = new Set<unknown>()
  const read = (value: unknown, depth: number): string => {
    if (depth > 6 || value == null || visited.has(value)) return ''
    if (typeof value === 'string') return value.slice(0, 32_768)
    if (typeof value !== 'object') return ''
    visited.add(value)
    const record = value as Record<string, unknown>
    return ['code', 'message', 'responseBody', 'body', 'data', 'error', 'cause', 'zenTransportFailure']
      .map((key) => read(record[key], depth + 1))
      .join(' ')
  }
  const text = read(error, 0)
  if (text.includes('model_daily_token_limit_exceeded') || text.includes('该模型额度今日已用完')) return 'exceeded'
  if (text.includes('model_daily_token_limit_pending') || text.includes('该模型剩余额度正在被其他任务使用'))
    return 'pending'
  if (text.includes('model_daily_turn_invalid') || text.includes('本轮模型授权已结束或过期')) return 'invalid'
  if (text.includes('model_daily_quota_unavailable') || text.includes('模型额度服务暂时不可用')) return 'unavailable'
  return undefined
}
