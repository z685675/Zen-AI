export type ModelDailyQuotaErrorKind = 'exceeded' | 'pending' | 'invalid' | 'timeout' | 'connection' | 'unavailable'
export const MODEL_DAILY_QUOTA_MESSAGE_KEYS = {
  exceeded: 'model_daily_quota.exceeded',
  pending: 'model_daily_quota.pending',
  invalid: 'model_daily_quota.invalid',
  timeout: 'model_daily_quota.timeout',
  connection: 'model_daily_quota.connection',
  unavailable: 'model_daily_quota.unavailable'
} as const

/** Recognize SDK-wrapped errors without relying on a generic HTTP 403/429. */
export function getModelDailyQuotaErrorKind(error: unknown): ModelDailyQuotaErrorKind | undefined {
  const visited = new Set<unknown>()
  const read = (value: unknown, depth: number): string => {
    if (depth > 6 || value == null || visited.has(value)) return ''
    if (typeof value === 'string') {
      if (value.length < 32_768 && value.trim().startsWith('{')) {
        try {
          return read(JSON.parse(value), depth + 1)
        } catch {
          /* Inspect plain error text below. */
        }
      }
      return value.slice(0, 32_768)
    }
    if (typeof value !== 'object') return ''
    visited.add(value)
    const record = value as Record<string, unknown>
    return [
      'name',
      'code',
      'message',
      'i18nKey',
      'responseBody',
      'body',
      'data',
      'error',
      'cause',
      'zenTransportFailure'
    ]
      .map((key) => read(record[key], depth + 1))
      .join(' ')
  }
  const text = read(error, 0)
  if (
    text.includes('model_daily_token_limit_exceeded') ||
    text.includes('该模型额度今日已用完') ||
    text.includes('该模型额度已达到日限额')
  )
    return 'exceeded'
  if (text.includes('model_daily_token_limit_pending') || text.includes('该模型剩余额度正在被其他任务使用'))
    return 'pending'
  if (text.includes('model_daily_turn_invalid') || text.includes('本轮模型授权已结束或过期')) return 'invalid'
  if (text.includes('model_daily_quota_unavailable') || text.includes('模型额度服务暂时不可用')) {
    const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined
    const transport = record?.zenTransportFailure as Record<string, unknown> | undefined
    const receivedHttpError =
      transport?.receivedResponse !== false && Number(transport?.status ?? record?.statusCode ?? record?.status) >= 400
    if (!receivedHttpError) {
      if (/timeouterror|timed?\s*out|timeout|etimedout/i.test(text)) return 'timeout'
      if (
        /failed to fetch|fetch failed|networkerror|network failure|enotfound|eai_again|econnrefused|certificate/i.test(
          text
        )
      )
        return 'connection'
    }
    return 'unavailable'
  }
  return undefined
}
