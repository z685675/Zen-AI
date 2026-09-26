import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { Model } from '@renderer/types'

type LocalModelHealth = {
  failureCount: number
  unavailableUntil: number
  lastFailureAt: number
}

const STORAGE_KEY_PREFIX = 'context-compaction-model-health:'
const INITIAL_COOLDOWN_MS = 5 * 60 * 1000

const healthCache = new Map<string, LocalModelHealth>()
const inFlightProbes = new Map<string, number>()
const knownModelKeysByProvider = new Map<string, Set<string>>()
let nextProbeToken = 0

const emitHealthUpdated = (): void => {
  if (typeof window !== 'undefined') {
    void EventEmitter.emit(EVENT_NAMES.CONTEXT_MODEL_HEALTH_UPDATED)
  }
}

const modelKey = (model: Model): string => `${model.provider}:${model.id}`.trim().toLowerCase()
const storageKey = (model: Model): string => `${STORAGE_KEY_PREFIX}${modelKey(model)}`
const providerKey = (providerId: string): string => providerId.trim().toLowerCase()

const rememberModelKey = (model: Model): string => {
  const key = modelKey(model)
  const provider = providerKey(model.provider)
  const keys = knownModelKeysByProvider.get(provider) ?? new Set<string>()
  keys.add(key)
  knownModelKeysByProvider.set(provider, keys)
  return key
}

const readHealth = (model: Model): LocalModelHealth | undefined => {
  const key = rememberModelKey(model)
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
  healthCache.set(rememberModelKey(model), health)
  if (typeof window !== 'undefined' && window.keyv) {
    window.keyv.set(storageKey(model), health)
  }
}

export const isContextCompactionModelCoolingDown = (model: Model, now = Date.now()): boolean => {
  const health = readHealth(model)
  if (health && health.unavailableUntil > now) return true
  return isContextCompactionModelProbeInFlight(model)
}

/** A recovery probe is also unavailable for real checkpoint requests. */
export const isContextCompactionModelProbeInFlight = (model: Model): boolean => inFlightProbes.has(modelKey(model))

/**
 * A model is probeable only after a previous context request or probe failed.
 * Keeping this separate from `isContextCompactionModelCoolingDown` is
 * important: a healthy model must not receive a background test every minute.
 */
export const isContextCompactionModelProbeDue = (model: Model, now = Date.now()): boolean => {
  const health = readHealth(model)
  return Boolean(health && health.unavailableUntil <= now)
}

/** Return the persisted recovery time, including an already-due probe. */
export const getContextCompactionModelUnavailableUntil = (model: Model): number | undefined =>
  readHealth(model)?.unavailableUntil

/**
 * Claim one background recovery probe for a model. The claim is intentionally
 * kept in memory: it prevents duplicate requests from overlapping while the
 * cooldown itself remains persisted across application restarts.
 */
export const beginContextCompactionModelProbe = (model: Model, now = Date.now(), force = false): boolean => {
  const key = modelKey(model)
  if (inFlightProbes.has(key) || (!force && !isContextCompactionModelProbeDue(model, now))) {
    return false
  }
  nextProbeToken += 1
  inFlightProbes.set(key, nextProbeToken)
  return true
}

export const getContextCompactionModelProbeToken = (model: Model): number | undefined =>
  inFlightProbes.get(modelKey(model))

export const recordContextCompactionModelFailure = (model: Model, now = Date.now()): LocalModelHealth => {
  const previous = readHealth(model)
  const failureCount = (previous?.failureCount ?? 0) + 1
  const health = {
    failureCount,
    // Recovery checks intentionally run on a fixed five-minute cadence. An
    // exponential backoff would make a temporarily recovered model stay out
    // of the fallback chain for too long.
    unavailableUntil: now + INITIAL_COOLDOWN_MS,
    lastFailureAt: now
  }
  inFlightProbes.delete(modelKey(model))
  writeHealth(model, health)
  emitHealthUpdated()
  return health
}

export const recordContextCompactionModelSuccess = (model: Model): void => {
  const key = rememberModelKey(model)
  inFlightProbes.delete(key)
  healthCache.delete(key)
  if (typeof window !== 'undefined' && window.keyv) {
    window.keyv.remove(storageKey(model))
  }
  emitHealthUpdated()
}

/** Complete a background probe only if its result still belongs to that probe. */
export const recordContextCompactionModelProbeSuccess = (model: Model, token: number): boolean => {
  if (getContextCompactionModelProbeToken(model) !== token) return false
  recordContextCompactionModelSuccess(model)
  return true
}

/** A stale probe must never re-freeze a model that recovered in the meantime. */
export const recordContextCompactionModelProbeFailure = (
  model: Model,
  token: number,
  now = Date.now()
): LocalModelHealth | undefined => {
  if (getContextCompactionModelProbeToken(model) !== token) return undefined
  return recordContextCompactionModelFailure(model, now)
}

/** Release a probe without changing health when the device is locally offline. */
export const releaseContextCompactionModelProbe = (model: Model, token: number): boolean => {
  if (getContextCompactionModelProbeToken(model) !== token) return false
  inFlightProbes.delete(modelKey(model))
  return true
}

/**
 * Provider credentials and routes are part of model health. A model frozen
 * through an old API key or endpoint must not stay frozen after the Provider
 * is edited. Current models are supplied by the caller so this also works
 * after an application restart, when only persisted health is available.
 */
export const resetContextCompactionModelHealthForProvider = (providerId: string, models: Model[] = []): void => {
  const normalizedProvider = providerKey(providerId)
  const keys = new Set(knownModelKeysByProvider.get(normalizedProvider) ?? [])

  for (const model of models) {
    keys.add(rememberModelKey(model))
  }

  for (const key of keys) {
    healthCache.delete(key)
    inFlightProbes.delete(key)
    if (typeof window !== 'undefined' && window.keyv) {
      window.keyv.remove(`${STORAGE_KEY_PREFIX}${key}`)
    }
  }

  knownModelKeysByProvider.delete(normalizedProvider)
  emitHealthUpdated()
}

/** Test-only reset hook; production callers should use success/failure events. */
export const resetContextCompactionModelHealth = (): void => {
  healthCache.clear()
  inFlightProbes.clear()
  knownModelKeysByProvider.clear()
  nextProbeToken = 0
}
