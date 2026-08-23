import type { Model } from '@renderer/types'

/**
 * Capabilities that can be learned from an actual provider response.
 * This is intentionally scoped to the provider/model pair because the same
 * model name can expose different capabilities behind different routes.
 */
export type LearnableModelCapability = 'function_calling' | 'vision' | 'reasoning' | 'web_search'

type CapabilityFailure = {
  failedAt: number
  expiresAt: number
}

type CapabilityFailureStore = Record<string, Partial<Record<LearnableModelCapability, CapabilityFailure>>>

const STORAGE_KEY = 'zenai:model-capability-failures:v1'
const FAILURE_TTL_MS = 30 * 24 * 60 * 60 * 1000

function getStorage(): Storage | undefined {
  try {
    return typeof globalThis !== 'undefined' && 'localStorage' in globalThis ? globalThis.localStorage : undefined
  } catch {
    return undefined
  }
}

function getModelKey(model: Model): string {
  return `${encodeURIComponent(model.provider)}:${encodeURIComponent(model.id)}`
}

function readStore(): CapabilityFailureStore {
  const storage = getStorage()
  if (!storage) return {}

  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as CapabilityFailureStore) : {}
  } catch {
    return {}
  }
}

function writeStore(store: CapabilityFailureStore): void {
  const storage = getStorage()
  if (!storage) return

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // A full or unavailable localStorage must never affect a chat request.
  }
}

function isValidFailure(value: unknown): value is CapabilityFailure {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as CapabilityFailure).failedAt === 'number' &&
    typeof (value as CapabilityFailure).expiresAt === 'number'
  )
}

/** Returns whether this capability has recently failed for this provider/model pair. */
export function hasLearnedModelCapabilityFailure(
  model: Model | undefined | null,
  capability: LearnableModelCapability
): boolean {
  if (!model) return false

  const store = readStore()
  const key = getModelKey(model)
  const failure = store[key]?.[capability]
  if (!isValidFailure(failure)) return false

  if (failure.expiresAt <= Date.now()) {
    const nextEntry = { ...store[key] }
    delete nextEntry[capability]
    if (Object.keys(nextEntry).length === 0) {
      delete store[key]
    } else {
      store[key] = nextEntry
    }
    writeStore(store)
    return false
  }

  return true
}

/** Records an unsupported-capability result for a limited period. */
export function rememberModelCapabilityFailure(
  model: Model | undefined | null,
  capability: LearnableModelCapability
): void {
  if (!model) return

  const store = readStore()
  const key = getModelKey(model)
  const now = Date.now()
  store[key] = {
    ...store[key],
    [capability]: {
      failedAt: now,
      expiresAt: now + FAILURE_TTL_MS
    }
  }
  writeStore(store)
}

/** Clears one learned failure, useful when a user or a provider refresh changes the route. */
export function clearLearnedModelCapabilityFailure(
  model: Model | undefined | null,
  capability?: LearnableModelCapability
): void {
  if (!model) return

  const store = readStore()
  const key = getModelKey(model)
  if (!store[key]) return

  if (capability) {
    const nextEntry = { ...store[key] }
    delete nextEntry[capability]
    if (Object.keys(nextEntry).length === 0) {
      delete store[key]
    } else {
      store[key] = nextEntry
    }
  } else {
    delete store[key]
  }
  writeStore(store)
}

/**
 * Capability learning only applies to errors that look like an unsupported
 * request parameter. Network, authentication, rate-limit and server errors
 * must not permanently disable a model capability.
 */
export function isLikelyUnsupportedModelCapabilityError(error: unknown, capability: LearnableModelCapability): boolean {
  const text = getErrorText(error).toLowerCase()
  if (!text) return false

  const statusCode = getStatusCode(error)
  if (statusCode !== undefined && (statusCode < 400 || statusCode >= 500)) {
    return false
  }

  const patterns: Record<LearnableModelCapability, RegExp> = {
    function_calling:
      /tool|function[_ -]?call|tool[_ -]?choice|parallel[_ -]?tool|(?:unsupported|not support|unknown|invalid).{0,40}(?:tool|function)/,
    vision:
      /image|vision|multimodal|content part|input[_ -]?image|(?:unsupported|not support|unknown|invalid).{0,40}(?:image|vision)/,
    reasoning:
      /reasoning|reasoning[_ -]?effort|thinking|think[_ -]?budget|budget[_ -]?tokens|(?:unsupported|not support|unknown|invalid).{0,40}(?:think|reason)/,
    web_search: /web[_ -]?search|search[_ -]?tool|search[_ -]?options|url[_ -]?context|grounding/
  }

  return patterns[capability].test(text)
}

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } }
  const status = value.statusCode ?? value.status ?? value.response?.status
  return typeof status === 'number' ? status : undefined
}

function getErrorText(error: unknown, depth = 0): string {
  if (depth > 3 || error == null) return ''
  if (typeof error === 'string') return error
  if (error instanceof Error) {
    return [error.name, error.message, getErrorText(error.cause, depth + 1)].filter(Boolean).join(' ')
  }
  if (typeof error !== 'object') return String(error)

  const value = error as Record<string, unknown>
  return [
    value.name,
    value.message,
    value.responseBody,
    value.response,
    value.cause,
    value.originalError,
    value.lastError,
    value.data
  ]
    .map((item) => getErrorText(item, depth + 1))
    .filter(Boolean)
    .join(' ')
}
