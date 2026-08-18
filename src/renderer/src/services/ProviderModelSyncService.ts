import { loggerService } from '@logger'
import { fetchModels, hasApiKey } from '@renderer/services/ApiService'
import store from '@renderer/store'
import { updateAssistants, updateDefaultAssistant } from '@renderer/store/assistants'
import { setDefaultModel, setQuickModel, setTranslateModel, updateProviders } from '@renderer/store/llm'
import type { Assistant, Message, Model, Provider, Topic } from '@renderer/types'

import {
  getProviderModelSyncFingerprint,
  markProviderModelSyncFailed,
  mergeSyncedProviderModels
} from './ProviderModelSyncUtils'
import { reconcileRemoteModelPolicyDefaults } from './RemoteModelPolicyService'

const logger = loggerService.withContext('ProviderModelSyncService')

// Keep this work outside the initial render path. It still starts immediately
// after the app has had a moment to rehydrate persisted settings.
const STARTUP_SYNC_DELAY_MS = 5 * 1000
const PROVIDER_MODEL_SYNC_INTERVAL_MS = 3 * 60 * 60 * 1000
const PROVIDER_MODEL_SYNC_RETRY_INTERVAL_MS = 3 * 60 * 60 * 1000
const PROVIDER_SYNC_GAP_MS = 1500
const PENDING_REMOVAL_CHECK_INTERVAL_MS = 15 * 1000

let schedulerStarted = false
let syncRunning = false
let syncTimer: ReturnType<typeof setInterval> | undefined
let startupTimer: ReturnType<typeof setTimeout> | undefined
let pendingRemovalTimer: ReturnType<typeof setInterval> | undefined

/** Models missing from the latest response but still used by a running message. */
const pendingModelRemovals = new Map<string, Set<string>>()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type SyncProviderModelsOptions = {
  force?: boolean
}

const isProviderSyncEligible = (provider: Provider): boolean => {
  if (!provider.enabled) {
    return false
  }

  if (!provider.apiHost && provider.type !== 'vertexai') {
    return false
  }

  // Reuse the same credential rules as normal API calls. In particular, this
  // keeps enabled Vertex AI/Ollama providers valid without making incomplete
  // provider entries block the startup page.
  return hasApiKey(provider)
}

const isProviderInFailureCooldown = (provider: Provider): boolean => {
  const now = Date.now()
  const lastAttemptAt = provider.modelSync?.lastAttemptAt ?? 0
  const lastSuccessAt = provider.modelSync?.lastSuccessAt ?? provider.modelSync?.syncedAt ?? 0
  const lastFailureAt = provider.modelSync?.lastFailureAt ?? 0

  return lastFailureAt > lastSuccessAt && now - lastAttemptAt < PROVIDER_MODEL_SYNC_RETRY_INTERVAL_MS
}

const shouldSyncProvider = (provider: Provider, options?: SyncProviderModelsOptions): boolean => {
  if (!isProviderSyncEligible(provider) || isProviderInFailureCooldown(provider)) {
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

const getModelKey = (model: Pick<Model, 'id' | 'provider'>): string => `${model.provider}:${model.id}`

const isRunningMessageStatus = (status: string | undefined): boolean =>
  status === 'processing' || status === 'pending' || status === 'searching'

const isModelUsedByRunningMessage = (providerId: string, modelId: string): boolean => {
  const state = store.getState()
  const expectedKey = `${providerId}:${modelId}`

  return (Object.values(state.messages.entities) as Array<Message | undefined>).some((message) => {
    if (!message || !isRunningMessageStatus(message.status)) {
      return false
    }

    if (message.model?.provider === providerId && message.model.id === modelId) {
      return true
    }

    return message.modelId === modelId || message.modelId === expectedKey
  })
}

const getFetchedModelIds = (models: Model[]): Set<string> =>
  new Set(models.filter((model) => model.id?.trim() && model.name?.trim()).map((model) => model.id.trim()))

const getProviderSyncBaseline = (provider: Provider): Provider => {
  if (provider.modelSync) {
    return provider
  }

  // Providers created before automatic sync did not have remoteModelIds. The
  // first successful response must still be able to remove stale imported
  // models, so treat the existing list as the previous remote snapshot once.
  return {
    ...provider,
    modelSync: {
      remoteModelIds: provider.models.map((model) => model.id),
      syncedAt: 0
    }
  }
}

const getMissingRemoteModelIds = (provider: Provider, fetchedModels: Model[]): string[] => {
  const fetchedModelIds = getFetchedModelIds(fetchedModels)
  const trackedModelIds = new Set([
    ...(provider.modelSync?.remoteModelIds ?? []),
    ...(pendingModelRemovals.get(provider.id) ?? [])
  ])

  return [...trackedModelIds].filter((modelId) => !fetchedModelIds.has(modelId))
}

const getRunningDeferredModelIds = (provider: Provider, missingModelIds: string[]): string[] =>
  missingModelIds.filter((modelId) => isModelUsedByRunningMessage(provider.id, modelId))

const getAvailableModels = (providers: Provider[]): Model[] =>
  providers.filter((provider) => provider.enabled).flatMap((provider) => provider.models)

const getAvailableModel = (model: Model | undefined, availableModels: Model[]): Model | undefined => {
  if (!model) {
    return undefined
  }

  return availableModels.find((candidate) => getModelKey(candidate) === getModelKey(model))
}

const repairAssistantModelReferences = (
  assistant: Assistant,
  fallbackModel: Model,
  availableModels: Model[]
): Assistant => {
  const repairModel = (model: Model | undefined): Model | undefined => {
    if (!model) {
      return undefined
    }

    return getAvailableModel(model, availableModels) ? model : fallbackModel
  }

  const nextTopics = (assistant.topics ?? []).map((topic: Topic) => {
    if (!topic.model || getAvailableModel(topic.model, availableModels)) {
      return topic
    }

    return { ...topic, model: fallbackModel }
  })

  return {
    ...assistant,
    model: repairModel(assistant.model),
    defaultModel: repairModel(assistant.defaultModel),
    topics: nextTopics
  }
}

/**
 * Keep persisted conversation references valid after a provider model disappears.
 * Missing global defaults are cleared instead of being replaced by the first
 * Provider model; the UI then presents the safe model-setup state.
 */
export const reconcileProviderModelReferences = (): void => {
  // A cached remote policy gets the first opportunity to resolve newly
  // imported models. Never choose the first Provider model implicitly.
  reconcileRemoteModelPolicyDefaults()

  const state = store.getState()
  const availableModels = getAvailableModels(state.llm.providers)
  const nextDefaultModel = getAvailableModel(state.llm.defaultModel, availableModels)
  const nextQuickModel = getAvailableModel(state.llm.quickModel, availableModels)
  const nextTranslateModel = getAvailableModel(state.llm.translateModel, availableModels)

  if (state.llm.defaultModel && !nextDefaultModel) {
    store.dispatch(setDefaultModel({ model: undefined }))
  }
  if (state.llm.quickModel && !nextQuickModel) {
    store.dispatch(setQuickModel({ model: undefined }))
  }
  if (state.llm.translateModel && !nextTranslateModel) {
    store.dispatch(setTranslateModel({ model: undefined }))
  }

  const fallbackModel = nextDefaultModel
  if (!fallbackModel) return

  const nextAssistants = state.assistants.assistants.map((assistant) =>
    repairAssistantModelReferences(assistant, fallbackModel, availableModels)
  )
  const nextDefaultAssistant = repairAssistantModelReferences(
    state.assistants.defaultAssistant,
    fallbackModel,
    availableModels
  )

  if (nextAssistants.some((assistant, index) => assistant !== state.assistants.assistants[index])) {
    store.dispatch(updateAssistants(nextAssistants))
  }
  if (nextDefaultAssistant !== state.assistants.defaultAssistant) {
    store.dispatch(updateDefaultAssistant({ assistant: nextDefaultAssistant }))
  }
}

const finalizePendingModelRemovals = (): void => {
  if (pendingModelRemovals.size === 0) {
    return
  }

  const providers = store.getState().llm.providers
  let changed = false
  const nextProviders = providers.map((provider) => {
    const pendingIds = pendingModelRemovals.get(provider.id)
    if (!pendingIds) {
      return provider
    }

    const remainingIds = [...pendingIds].filter((modelId) => isModelUsedByRunningMessage(provider.id, modelId))
    const removableIds = new Set([...pendingIds].filter((modelId) => !remainingIds.includes(modelId)))

    if (removableIds.size === 0) {
      return provider
    }

    changed = true
    const nextProvider = {
      ...provider,
      models: provider.models.filter((model) => !removableIds.has(model.id))
    }

    if (remainingIds.length > 0) {
      pendingModelRemovals.set(provider.id, new Set(remainingIds))
    } else {
      pendingModelRemovals.delete(provider.id)
    }

    return nextProvider
  })

  if (!changed) {
    return
  }

  store.dispatch(updateProviders(nextProviders))
  reconcileProviderModelReferences()
}

export const syncProviderModelsOnce = async (options?: SyncProviderModelsOptions): Promise<void> => {
  if (syncRunning) {
    return
  }

  syncRunning = true

  try {
    finalizePendingModelRemovals()

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
        const validFetchedModels = fetchedModels.filter((model) => model.id?.trim() && model.name?.trim())
        if (validFetchedModels.length === 0) {
          logger.warn('Skip provider model sync because fetched model list is empty', {
            providerId: provider.id,
            providerName: provider.name
          })
          failedSyncByProvider.set(provider.id, { sourceFingerprint, attemptedAt })
          continue
        }

        fetchedModelsByProvider.set(provider.id, {
          models: validFetchedModels,
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
        failedSyncByProvider.set(provider.id, { sourceFingerprint, attemptedAt })
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

            const syncBaseline = getProviderSyncBaseline(provider)
            const missingModelIds = getMissingRemoteModelIds(syncBaseline, syncResult.models)
            const deferredModelIds = getRunningDeferredModelIds(provider, missingModelIds)

            if (deferredModelIds.length > 0) {
              pendingModelRemovals.set(provider.id, new Set(deferredModelIds))
            } else {
              pendingModelRemovals.delete(provider.id)
            }

            return mergeSyncedProviderModels(syncBaseline, syncResult.models, {
              preserveModelIds: deferredModelIds,
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

    reconcileProviderModelReferences()
    try {
      await window.api.agentLifecycle.bootstrapBuiltins()
    } catch (error) {
      logger.warn('Failed to initialize the built-in assistant after Provider model sync', error as Error)
    }
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
    void syncProviderModelsOnce({ force: true })
  }, STARTUP_SYNC_DELAY_MS)

  syncTimer = setInterval(() => {
    void syncProviderModelsOnce()
  }, PROVIDER_MODEL_SYNC_INTERVAL_MS)

  pendingRemovalTimer = setInterval(finalizePendingModelRemovals, PENDING_REMOVAL_CHECK_INTERVAL_MS)
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

  if (pendingRemovalTimer) {
    clearInterval(pendingRemovalTimer)
    pendingRemovalTimer = undefined
  }

  pendingModelRemovals.clear()
  schedulerStarted = false
}
