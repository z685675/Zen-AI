import { loggerService } from '@logger'
import { isAssistantModelIdentifierBlocked } from '@renderer/config/agentModelPolicy'
import store from '@renderer/store'
import { updateAssistants, updateDefaultAssistant } from '@renderer/store/assistants'
import { setDefaultModel, setQuickModel, setTranslateModel, updateProviders } from '@renderer/store/llm'
import type { Assistant, Model, Provider } from '@renderer/types'
import { isTextFallbackIdentifier, selectRecoverableModel } from '@shared/config/modelRecovery'
import { isZenManagedApiHost } from '@shared/config/zenProvider'

import { modelRecoveryIntents, withAutomaticModelChange } from './modelRecoveryIntents'
import { getProviderModelSyncFingerprint, mergeSyncedProviderModels } from './ProviderModelSyncUtils'
import { refreshRemoteModelPolicy } from './RemoteModelPolicyService'

const logger = loggerService.withContext('ModelAvailabilitySync')
const known = new Map<string, string>()
const streams = new Map<string, EventSource>()
let reconciling = false
let syncing: Promise<void> | undefined
let resync = false
let started = false
let dispose: (() => void) | undefined

export const hasAuthoritativeModelAvailability = (providerId: string): boolean => {
  const provider = store.getState().llm.providers.find((provider: Provider) => provider.id === providerId)
  return Boolean(provider && known.get(providerId) === getProviderModelSyncFingerprint(provider))
}

const modelKey = (model?: Model): string | null => (model ? `${model.provider}:${model.id}` : null)

export function reconcileManagedModelReferences(): void {
  if (reconciling) return
  reconciling = true
  try {
    const state = store.getState()
    const policy = state.llm.modelPolicy?.policy
    const resolve = (slot: string, current: Model | undefined): Model | undefined => {
      const saved = modelRecoveryIntents.get(slot)
      const defaultId =
        slot === 'global:chat'
          ? policy?.defaults.chat
          : slot === 'global:quick'
            ? policy?.defaults.quick
            : slot === 'global:translate'
              ? policy?.defaults.translate
              : undefined
      const providerId = current?.provider ?? saved?.preferred.split(':')[0]
      const provider = providerId
        ? state.llm.providers.find((provider) => provider.id === providerId && provider.enabled)
        : defaultId
          ? state.llm.providers.find(
              (provider) =>
                provider.enabled &&
                isZenManagedApiHost(provider.apiHost) &&
                hasAuthoritativeModelAvailability(provider.id)
            )
          : undefined
      if (!provider || !hasAuthoritativeModelAvailability(provider.id) || !isZenManagedApiHost(provider.apiHost))
        return current
      const models = provider.models.filter(
        (model) =>
          isTextFallbackIdentifier(model.id) &&
          model.endpoint_type !== 'image-generation' &&
          model.endpoint_type !== 'jina-rerank' &&
          !isAssistantModelIdentifierBlocked(model.id, policy)
      )
      // Non-text selections are managed by their own feature, never by this chain.
      if (current && !isTextFallbackIdentifier(current.id)) return current
      const result = selectRecoverableModel({
        current: modelKey(current),
        preferred: defaultId ? `${provider.id}:${defaultId}` : undefined,
        intent: saved,
        available: models.map((model) => modelKey(model)!),
        fallbacks: (policy?.assistant.fallbackModels ?? [])
          .filter(isTextFallbackIdentifier)
          .map((id) => `${provider.id}:${id}`),
        now: Date.now()
      })
      modelRecoveryIntents.set(slot, result.intent)
      return result.selected ? models.find((model) => modelKey(model) === result.selected) : undefined
    }
    withAutomaticModelChange(() => {
      const active =
        state.runtime.generating ||
        state.runtime.translating ||
        Object.values(state.messages.loadingByTopic).some(Boolean) ||
        Object.values(state.runtime.loadingMap).some(Boolean)
      for (const [slot, current, action] of [
        ['chat', state.llm.defaultModel, setDefaultModel],
        ['quick', state.llm.quickModel, setQuickModel],
        ['translate', state.llm.translateModel, setTranslateModel]
      ] as const) {
        if (active) continue
        const next = resolve(`global:${slot}`, current)
        if (modelKey(next) !== modelKey(current)) store.dispatch(action({ model: next }))
      }
      const repairAssistant = (assistant: Assistant): Assistant => {
        // Running turns retain their frozen input. The next idle reconciliation
        // repairs these refs; no messages or historical model labels are rewritten.
        if (assistant.topics?.some((topic) => state.messages.loadingByTopic[topic.id])) return assistant
        let changed = false
        const field = (slot: string, current: Model | undefined) => {
          const next = resolve(slot, current)
          if (modelKey(next) !== modelKey(current)) changed = true
          return next
        }
        const model = field(`assistant:${assistant.id}:model`, assistant.model)
        const defaultModel = field(`assistant:${assistant.id}:defaultModel`, assistant.defaultModel)
        const topics = assistant.topics?.map((topic) => {
          const model = field(`topic:${topic.id}`, topic.model)
          return modelKey(model) === modelKey(topic.model) ? topic : { ...topic, model }
        })
        return changed ? { ...assistant, model, defaultModel, topics } : assistant
      }
      const assistants = state.assistants.assistants.map(repairAssistant)
      if (assistants.some((assistant, index) => assistant !== state.assistants.assistants[index]))
        store.dispatch(updateAssistants(assistants))
      const defaultAssistant = repairAssistant(state.assistants.defaultAssistant)
      if (defaultAssistant !== state.assistants.defaultAssistant)
        store.dispatch(updateDefaultAssistant({ assistant: defaultAssistant }))
    })
  } finally {
    reconciling = false
  }
}

export async function syncManagedModelAvailability(): Promise<void> {
  if (syncing) {
    resync = true
    return syncing
  }
  syncing = (async () => {
    do {
      resync = false
      const providers = store
        .getState()
        .llm.providers.filter((provider) => provider.enabled && isZenManagedApiHost(provider.apiHost))
      await Promise.all(
        providers.map(async (provider: Provider) => {
          const fingerprint = getProviderModelSyncFingerprint(provider)
          const snapshot = await window.api.modelPolicy.availability(provider)
          const current = store.getState().llm.providers.find((candidate) => candidate.id === provider.id)
          if (!snapshot || !current || getProviderModelSyncFingerprint(current) !== fingerprint) return
          // Old cached successes may be used in main-process admission, but a
          // failed refresh must not masquerade as a fresh supply change here.
          known.set(provider.id, fingerprint)
          const fetched = snapshot.models.map(
            (model): Model => ({
              id: model.id,
              name: model.name || model.id,
              provider: provider.id,
              group: provider.id,
              supported_endpoint_types: model.supported_endpoint_types
            })
          )
          const merged = mergeSyncedProviderModels(
            {
              ...current,
              modelSync: {
                ...current.modelSync,
                remoteModelIds: current.models.map((model) => model.id),
                syncedAt: current.modelSync?.syncedAt ?? 0
              }
            },
            fetched,
            { sourceFingerprint: fingerprint, syncedAt: snapshot.fetchedAt, authoritativeEmpty: true }
          )
          store.dispatch(
            updateProviders(
              store.getState().llm.providers.map((candidate) => (candidate.id === provider.id ? merged : candidate))
            )
          )
        })
      )
      reconcileManagedModelReferences()
      await window.api.modelPolicy.reconcileSessions()
    } while (resync)
  })()
    .catch((error) => logger.warn('Managed model synchronization failed', error as Error))
    .finally(() => {
      syncing = undefined
    })
  return syncing
}

export function startManagedModelAvailabilitySync(): void {
  if (started) return
  started = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const retryDelays = new Map<string, number>()
  const refresh = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      void refreshRemoteModelPolicy()
        .catch((error) => logger.warn('Policy refresh failed', error as Error))
        .then(() => syncManagedModelAvailability())
    }, 250)
  }
  const updateStreams = () => {
    const origins = new Set<string>(
      store
        .getState()
        .llm.providers.filter((provider: Provider) => provider.enabled && isZenManagedApiHost(provider.apiHost))
        .map((provider: Provider) => new URL(provider.apiHost).origin)
    )
    for (const [origin, stream] of streams)
      if (!origins.has(origin)) {
        stream.close()
        streams.delete(origin)
      }
    for (const [origin, retry] of retryTimers)
      if (!origins.has(origin)) {
        clearTimeout(retry)
        retryTimers.delete(origin)
        retryDelays.delete(origin)
      }
    if (typeof EventSource !== 'undefined')
      for (const origin of origins) {
        if (streams.has(origin) || retryTimers.has(origin)) continue
        const stream = new EventSource(`${origin}/api/client/model-events`)
        stream.addEventListener('models-changed', refresh)
        stream.onopen = () => {
          retryDelays.delete(origin)
          refresh()
        } // Full snapshot after reconnect.
        stream.onerror = () => {
          stream.close()
          streams.delete(origin)
          if (retryTimers.has(origin) || !started) return
          const delay = Math.min(5 * 60_000, retryDelays.get(origin) ?? 60_000)
          retryDelays.set(origin, delay * 2)
          retryTimers.set(
            origin,
            setTimeout(() => {
              retryTimers.delete(origin)
              updateStreams()
            }, delay)
          )
        }
        streams.set(origin, stream)
      }
  }
  let observed = store.getState()
  const sources = () =>
    JSON.stringify(
      store
        .getState()
        .llm.providers.map((provider: Provider) => [provider.enabled, getProviderModelSyncFingerprint(provider)])
    )
  let observedSources = sources()
  const unsubscribe = store.subscribe(() => {
    const previous = observed
    observed = store.getState()
    if (previous.llm.providers !== observed.llm.providers) {
      const nextSources = sources()
      if (nextSources !== observedSources) {
        observedSources = nextSources
        updateStreams()
        refresh()
      }
    }
    if (
      previous.llm !== observed.llm ||
      previous.assistants !== observed.assistants ||
      previous.messages.loadingByTopic !== observed.messages.loadingByTopic
    )
      reconcileManagedModelReferences()
  })
  const interval = setInterval(refresh, 5 * 60_000)
  const recovery = setInterval(() => {
    reconcileManagedModelReferences()
    void window.api.modelPolicy
      .reconcileSessions()
      .catch((error) => logger.warn('Session recovery reconciliation failed', error as Error))
  }, 15_000)
  const visible = () => {
    if (document.visibilityState === 'visible') refresh()
  }
  window.addEventListener('online', refresh)
  window.addEventListener('beforeunload', stopManagedModelAvailabilitySync)
  document.addEventListener('visibilitychange', visible)
  updateStreams()
  refresh()
  dispose = () => {
    clearTimeout(timer)
    clearInterval(interval)
    clearInterval(recovery)
    unsubscribe()
    window.removeEventListener('online', refresh)
    document.removeEventListener('visibilitychange', visible)
    window.removeEventListener('beforeunload', stopManagedModelAvailabilitySync)
    for (const retry of retryTimers.values()) clearTimeout(retry)
    for (const stream of streams.values()) stream.close()
    streams.clear()
    known.clear()
    started = false
  }
}

export const stopManagedModelAvailabilitySync = (): void => dispose?.()
