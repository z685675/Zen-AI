import type { Model } from '@renderer/types'

type LocalModelHealth = {
  failureCount: number
  unavailableUntil: number
  lastFailureAt: number
}

const STORAGE_KEY_PREFIX = 'context-compaction-model-health:'
const INITIAL_COOLDOWN_MS = 5 * 60 * 1000
const MAX_COOLDOWN_MS = 30 * 60 * 1000

const healthCache = new Map<string, LocalModelHealth>()

const modelKey = (model: Model): string => `${model.provider}:${model.id}`.trim().toLowerCase()
const storageKey = (model: Model): string => `${STORAGE_KEY_PREFIX}${modelKey(model)}`

const readHealth = (model: Model): LocalModelHealth | undefined => {
  const key = modelKey(model)
  const cached = healthCache.get(key)
  if (cached) return cached

  if (typeof window === 'undefined' || !window.keyv) return undefined
  const stored = window.keyv.get(storageKey(model))
  if (!stored || typeof stored !== 'object') return undefined

  const value = stored as Partial<LocalModelHealth>
  if (
    typeof value.failureCount !== 'number' ||
    typeof value.unavailableUntil !== 'number' ||
    typeof value.lastFailureAt !== 'number'
  ) {
    return undefined
  }

  const health = {
    failureCount: Math.max(0, Math.floor(value.failureCount)),
    unavailableUntil: Math.max(0, value.unavailableUntil),
    lastFailureAt: Math.max(0, value.lastFailureAt)
  }
  healthCache.set(key, health)
  return health
}

const writeHealth = (model: Model, health: LocalModelHealth): void => {
  healthCache.set(modelKey(model), health)
  if (typeof window !== 'undefined' && window.keyv) {
    window.keyv.set(storageKey(model), health)
  }
}

export const isContextCompactionModelCoolingDown = (model: Model, now = Date.now()): boolean => {
  const health = readHealth(model)
  if (!health) return false
  if (health.unavailableUntil <= now) return false
  return true
}

export const recordContextCompactionModelFailure = (model: Model, now = Date.now()): LocalModelHealth => {
  const previous = readHealth(model)
  const failureCount = (previous?.failureCount ?? 0) + 1
  const cooldown = Math.min(MAX_COOLDOWN_MS, INITIAL_COOLDOWN_MS * 2 ** Math.min(failureCount - 1, 3))
  const health = {
    failureCount,
    unavailableUntil: now + cooldown,
    lastFailureAt: now
  }
  writeHealth(model, health)
  return health
}

export const recordContextCompactionModelSuccess = (model: Model): void => {
  const key = modelKey(model)
  healthCache.delete(key)
  if (typeof window !== 'undefined' && window.keyv) {
    window.keyv.remove(storageKey(model))
  }
}

/** Test-only reset hook; production callers should use success/failure events. */
export const resetContextCompactionModelHealth = (): void => {
  healthCache.clear()
}
