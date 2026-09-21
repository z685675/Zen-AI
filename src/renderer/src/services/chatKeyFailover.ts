import type { Provider } from '@renderer/types'

type ErrorRecord = Record<string, unknown>

function asRecord(value: unknown): ErrorRecord | undefined {
  return value && typeof value === 'object' ? (value as ErrorRecord) : undefined
}

function getNestedStatus(value: unknown): number | undefined {
  const record = asRecord(value)
  if (!record) return undefined

  const candidates = [record.statusCode, record.status]
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate
    }
    if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) {
      return Number(candidate)
    }
  }

  const response = asRecord(record.response)
  if (response) {
    const responseStatus = response.status
    if (typeof responseStatus === 'number' && Number.isFinite(responseStatus)) {
      return responseStatus
    }
  }

  return undefined
}

export function getErrorStatusCode(error: unknown): number | undefined {
  const directStatus = getNestedStatus(error)
  if (directStatus !== undefined) return directStatus

  const record = asRecord(error)
  return getNestedStatus(record?.cause)
}

function getErrorText(error: unknown): string {
  const record = asRecord(error)
  const values = [
    record?.message,
    record?.responseBody,
    record?.data,
    asRecord(record?.cause)?.message,
    asRecord(record?.cause)?.responseBody
  ]

  return values
    .filter((value) => value !== undefined && value !== null)
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join(' ')
    .toLowerCase()
}

/**
 * Only rotate a conversation's configured key when the failure points to the
 * key/credential itself. A generic 429 is deliberately excluded because it
 * can be a service or channel capacity response and rotating the client key
 * would fragment the prompt cache without fixing the root cause.
 */
export function shouldRotateChatApiKey(error: unknown): boolean {
  const statusCode = getErrorStatusCode(error)
  if (statusCode !== 401 && statusCode !== 403 && statusCode !== 429) {
    return false
  }

  const text = getErrorText(error)
  if (statusCode === 401) return true

  if (statusCode === 403) {
    return (
      text.length === 0 ||
      /api[\s_-]?key|apikey|authorization|unauthorized|credential|token|forbidden|permission|access denied/.test(text)
    )
  }

  // 429 is only considered key-scoped when the response explicitly relates
  // the limit/quota to a key or token.
  return /(?:api[\s_-]?key|apikey|token)[^\n]{0,80}(?:limit|quota|rate)|(?:limit|quota|rate)[^\n]{0,80}(?:api[\s_-]?key|apikey|token)|insufficient[\s_-]?quota/.test(
    text
  )
}

export function getProviderApiKeys(apiKey?: string): string[] {
  return (apiKey || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
}

export function orderChatApiKeys(provider: Provider, stableKey: string): string[] {
  const keys = getProviderApiKeys(provider.apiKey)
  if (keys.length <= 1) return keys

  const currentIndex = keys.indexOf(stableKey)
  if (currentIndex < 0) return keys

  return [...keys.slice(currentIndex), ...keys.slice(0, currentIndex)]
}
