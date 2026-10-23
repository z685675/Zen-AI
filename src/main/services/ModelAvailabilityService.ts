import { createHash } from 'node:crypto'

import { loggerService } from '@logger'
import { type ModelAvailabilitySnapshot, parseAvailableModels } from '@shared/config/modelAvailability'
import { isZenManagedApiHost } from '@shared/config/zenProvider'
import type { Provider } from '@types'
import { net } from 'electron'

const logger = loggerService.withContext('ModelAvailabilityService')
const snapshots = new Map<string, ModelAvailabilitySnapshot>()
const pending = new Map<string, Promise<ModelAvailabilitySnapshot | undefined>>()
const requestedSources = new Map<string, string>()

function validProvider(provider: Provider): boolean {
  if (
    !provider ||
    typeof provider.id !== 'string' ||
    !provider.id ||
    provider.id.length > 256 ||
    typeof provider.apiHost !== 'string' ||
    typeof provider.apiKey !== 'string' ||
    provider.apiKey.length > 64_000
  )
    return false
  try {
    const url = new URL(provider.apiHost)
    return url.protocol === 'https:' && !url.username && !url.password && isZenManagedApiHost(provider.apiHost)
  } catch {
    return false
  }
}

export const availabilityFingerprint = (provider: Provider): string =>
  createHash('sha256').update(`${provider.id}\n${provider.apiHost}\n${provider.apiKey}`).digest('hex')

export function getCachedModelAvailability(provider: Provider): ModelAvailabilitySnapshot | undefined {
  const value = snapshots.get(provider.id)
  return value?.fingerprint === availabilityFingerprint(provider) ? value : undefined
}

export async function refreshModelAvailability(
  provider: Provider,
  force = false
): Promise<ModelAvailabilitySnapshot | undefined> {
  if (!validProvider(provider)) return undefined
  if (!provider.enabled || !provider.apiKey.trim()) {
    requestedSources.delete(provider.id)
    snapshots.delete(provider.id)
    return undefined
  }
  const fingerprint = availabilityFingerprint(provider)
  requestedSources.set(provider.id, fingerprint)
  const cached = getCachedModelAvailability(provider)
  if (!force && cached && Date.now() - cached.fetchedAt < 60_000) return cached
  const key = `${provider.id}:${fingerprint}`
  const existing = pending.get(key)
  if (existing) return existing
  const task = (async () => {
    try {
      const keys = [
        ...new Set(
          provider.apiKey
            .split(/(?<!\\),|\r?\n/)
            .map((key) => key.trim().replace(/\\,/g, ','))
            .filter(Boolean)
        )
      ]
      if (!keys.length || keys.length > 32) throw new Error('invalid_model_availability_keys')
      const modelsByKey = await Promise.all(
        keys.map(async (apiKey) => {
          const response = await net.fetch(new URL('/api/client/models', provider.apiHost).toString(), {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(8_000),
            redirect: 'error'
          })
          if (!response.ok || response.headers.get('X-Zen-Models-Authoritative') !== '1')
            throw new Error(`model_availability_http_${response.status}`)
          return parseAvailableModels(await response.json())
        })
      )
      // Rotation must be safe for every configured key, not grant the union of
      // permissions and fail when the next request happens to choose another key.
      const models = (modelsByKey[0] ?? []).filter((model) =>
        modelsByKey.every((list) => list.some((candidate) => candidate.id === model.id))
      )
      const snapshot = { providerId: provider.id, fingerprint, fetchedAt: Date.now(), models }
      if (requestedSources.get(provider.id) !== fingerprint) return undefined
      snapshots.set(provider.id, snapshot)
      return snapshot
    } catch (error) {
      logger.warn('Availability refresh failed; retaining last complete snapshot', { providerId: provider.id, error })
      return requestedSources.get(provider.id) === fingerprint ? cached : undefined
    } finally {
      pending.delete(key)
    }
  })()
  pending.set(key, task)
  return task
}
