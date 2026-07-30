import { loggerService } from '@logger'
import { fetchModels } from '@renderer/services/ApiService'
import store from '@renderer/store'
import { updateProviders } from '@renderer/store/llm'
import type { Model, Provider } from '@renderer/types'
import { isSystemProvider } from '@renderer/types'
import { isZenManagedApiHost } from '@renderer/utils/zenClientHeaders'

import {
  getProviderModelSyncFingerprint,
  markProviderModelSyncFailed,
  mergeSyncedProviderModels
} from './ProviderModelSyncUtils'

const logger = loggerService.withContext('ProviderModelSyncService')

const STARTUP_SYNC_DELAY_MS = 60 * 1000
const PROVIDER_MODEL_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000
const PROVIDER_MODEL_SYNC_RETRY_INTERVAL_MS = 3 * 60 * 60 * 1000
const PROVIDER_SYNC_GAP_MS = 1500

let schedulerStarted = false
let syncRunning = false
let syncTimer: ReturnType<typeof setInterval> | undefined
let startupTimer: ReturnType<typeof setTimeout> | undefined

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type SyncProviderModelsOptions = {
  force?: boolean
  officialOnly?: boolean
}

const isProviderSyncEligible = (provider: Provider): boolean => {
  if (!provider.enabled || isSystemProvider(provider)) {
    return false
  }

  if (!provider.apiHost && provider.type !== 'vertexai') {
    return false
  }

  if (!provider.apiKey && provider.type !== 'ollama') {
    return false
  }

  return true
}

const isOfficialZenProvider = (provider: Provider): boolean => {
  return isZenManagedApiHost(provider.apiHost) || isZenManagedApiHost(provider.anthropicApiHost)
}

const isProviderInFailureCooldown = (provider: Provider): boolean => {
  const now = Date.now()
  const lastAttemptAt = provider.modelSync?.lastAttemptAt ?? 0
  const lastSuccessAt = provider.modelSync?.lastSuccessAt ?? provider.modelSync?.syncedAt ?? 0
  const lastFailureAt = provider.modelSync?.lastFailureAt ?? 0

  return lastFailureAt > lastSuccessAt && now - lastAttemptAt < PROVIDER_MODEL_SYNC_RETRY_INTERVAL_MS
}

const shouldSyncProvider = (provider: Provider, options?: SyncProviderModelsOptions): boolean => {
  if (!isProviderSyncEligible(provider)) {
    return false
  }

  if (options?.officialOnly && !isOfficialZenProvider(provider)) {
    return false
  }

  if (isProviderInFailureCooldown(provider)) {
    return false
  }

  if (options?.force) {
    return true
  }

  const now = Date.now()
  const sourceFingerprint = getProviderModelSyncFingerprint(provider)
  const previousSourceFingerprint = provider.modelSync?.sourceFingerprint

  if (previousSourceFingerprint !== sourceFingerprint) {
    return true
  }

  const lastSuccessAt = provider.modelSync?.lastSuccessAt ?? provider.modelSync?.syncedAt ?? 0
  return now - lastSuccessAt >= PROVIDER_MODEL_SYNC_INTERVAL_MS
}

const getProtectedModelIds = (providerId: string): string[] => {
  const state = store.getState()
  return [state.llm.defaultModel, state.llm.quickModel, state.llm.translateModel]
    .filter((model: Model | undefined) => model?.provider === providerId)
    .map((model: Model | undefined) => model?.id)
    .filter((id): id is string => Boolean(id))
}

export const syncProviderModelsOnce = async (options?: SyncProviderModelsOptions): Promise<void> => {
  if (syncRunning) {
    return
  }

  syncRunning = true

  try {
    const state = store.getState()
    const providersToSync = state.llm.providers.filter((provider) => shouldSyncProvider(provider, options))

    if (providersToSync.length === 0) {
      return
    }

    const fetchedModelsByProvider = new Map<
      string,
      { models: Model[]; sourceFingerprint: string; attemptedAt: number; syncedAt: number }
    >()
    const failedSyncByProvider = new Map<string, { sourceFingerprint: string; attemptedAt: number }>()

    for (const provider of providersToSync) {
      const attemptedAt = Date.now()
      const sourceFingerprint = getProviderModelSyncFingerprint(provider)

      try {
        const fetchedModels = await fetchModels(provider)
        if (fetchedModels.length === 0) {
          logger.warn('Skip provider model sync because fetched model list is empty', {
            providerId: provider.id,
            providerName: provider.name
          })
          failedSyncByProvider.set(provider.id, {
            sourceFingerprint,
            attemptedAt
          })
          continue
        }

        fetchedModelsByProvider.set(provider.id, {
          models: fetchedModels,
          sourceFingerprint,
          attemptedAt,
          syncedAt: Date.now()
        })
      } catch (error) {
        logger.warn('Provider model sync failed', {
          providerId: provider.id,
          providerName: provider.name,
          error
        })
        failedSyncByProvider.set(provider.id, {
          sourceFingerprint,
          attemptedAt
        })
      }

      await sleep(PROVIDER_SYNC_GAP_MS)
    }

    if (fetchedModelsByProvider.size === 0 && failedSyncByProvider.size === 0) {
      return
    }

    const latestProviders = store.getState().llm.providers
    store.dispatch(
      updateProviders(
        latestProviders.map((provider) => {
          const syncResult = fetchedModelsByProvider.get(provider.id)
          if (syncResult) {
            if (getProviderModelSyncFingerprint(provider) !== syncResult.sourceFingerprint) {
              return provider
            }

            return mergeSyncedProviderModels(provider, syncResult.models, {
              preserveModelIds: getProtectedModelIds(provider.id),
              sourceFingerprint: syncResult.sourceFingerprint,
              attemptedAt: syncResult.attemptedAt,
              syncedAt: syncResult.syncedAt
            })
          }

          const failedSync = failedSyncByProvider.get(provider.id)
          if (!failedSync || getProviderModelSyncFingerprint(provider) !== failedSync.sourceFingerprint) {
            return provider
          }

          return markProviderModelSyncFailed(provider, failedSync)
        })
      )
    )
  } finally {
    syncRunning = false
  }
}

export const startProviderModelSyncScheduler = (): void => {
  if (schedulerStarted) {
    return
  }

  schedulerStarted = true

  startupTimer = setTimeout(() => {
    void syncProviderModelsOnce({ force: true, officialOnly: true })
  }, STARTUP_SYNC_DELAY_MS)

  syncTimer = setInterval(() => {
    void syncProviderModelsOnce()
  }, PROVIDER_MODEL_SYNC_INTERVAL_MS)
}

export const stopProviderModelSyncScheduler = (): void => {
  if (startupTimer) {
    clearTimeout(startupTimer)
    startupTimer = undefined
  }

  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = undefined
  }

  schedulerStarted = false
}
