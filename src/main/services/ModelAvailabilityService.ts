import { createHash } from 'node:crypto'

import { loggerService } from '@logger'
import { type ModelAvailabilitySnapshot, parseAvailableModels } from '@shared/config/modelAvailability'
import { isZenManagedApiHost } from '@shared/config/zenProvider'
import { intersectModelCapabilities, setProviderModelCapabilities } from '@shared/modelCapabilities'
import { discardResponseBody } from '@shared/modelTransport'
import { splitApiKeyString } from '@shared/utils/apiKeys'
import type { Provider } from '@types'

import { managedApiFetch } from './modelTransport/apiFetch'

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
    setProviderModelCapabilities(provider.id, [])
    return undefined
  }
  const fingerprint = availabilityFingerprint(provider)
  if (requestedSources.get(provider.id) !== fingerprint) setProviderModelCapabilities(provider.id, [])
  requestedSources.set(provider.id, fingerprint)
  const cached = getCachedModelAvailability(provider)
  if (!force && cached && Date.now() - cached.fetchedAt < 60_000) return cached
  const key = `${provider.id}:${fingerprint}`
  const existing = pending.get(key)
  if (existing) return existing
  const task = (async () => {
    try {
      const keys = [...new Set(splitApiKeyString(provider.apiKey))]
      if (!keys.length || keys.length > 32) throw new Error('invalid_model_availability_keys')
      const results = await Promise.all(
        keys.map(async (apiKey) => {
          const response = await managedApiFetch(new URL('/api/client/models', provider.apiHost).toString(), {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(8_000),
            redirect: 'error'
          })
          if (!response.ok || response.headers.get('X-Zen-Models-Authoritative') !== '1') {
            discardResponseBody(response)
            if (response.status === 401) return null
            throw new Error(`model_availability_http_${response.status}`)
          }
          return parseAvailableModels(await response.json())
        })
      )
      const modelsByKey = results.filter((models) => models !== null)
      if (!modelsByKey.length) throw new Error('model_availability_no_authorized_keys')
      // Rotation must be safe for every authorized key, not grant the union of
      // permissions and fail when the next request happens to choose another key.
      const models = (modelsByKey[0] ?? []).filter((model) =>
        modelsByKey.every((list) => list.some((candidate) => candidate.id === model.id))
      )
      const safeModels = models.map((entry) => ({
        ...entry,
        model_capabilities: intersectModelCapabilities(
          modelsByKey.map((list) => list.find((m) => m.id === entry.id)?.model_capabilities)
        )
      }))
      const snapshot = { providerId: provider.id, fingerprint, fetchedAt: Date.now(), models: safeModels }
      if (requestedSources.get(provider.id) !== fingerprint) return undefined
      snapshots.set(provider.id, snapshot)
      setProviderModelCapabilities(provider.id, snapshot.models)
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
