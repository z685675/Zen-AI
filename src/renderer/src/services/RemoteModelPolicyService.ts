import { loggerService } from '@logger'
import { resolveIndependentModel, resolveRemoteDefaultModel } from '@renderer/config/remoteModelPolicy'
import {
  beginContextCompactionModelProbe,
  getContextCompactionModelProbeToken,
  getContextCompactionModelUnavailableUntil,
  isContextCompactionModelProbeDue,
  isContextCompactionModelProbeInFlight,
  recordContextCompactionModelProbeFailure,
  recordContextCompactionModelProbeSuccess,
  releaseContextCompactionModelProbe,
  resetContextCompactionModelHealthForProvider
} from '@renderer/services/context/ContextCompactionModelHealthService'
import {
  CONTEXT_COMPACTION_REQUEST_HEADERS,
  isContextCompactionModelFailureFreezable,
  isContextCompactionTextModel
} from '@renderer/services/context/ContextCompactionModelService'
import { ContextModelProbeScheduler } from '@renderer/services/context/ContextModelProbeScheduler'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { checkModelWithAnyKey } from '@renderer/services/HealthCheckService'
import { modelRecoveryIntents } from '@renderer/services/modelRecoveryIntents'
import store, { type RootState } from '@renderer/store'
import { applyRemoteModelPolicy, setModelPolicy } from '@renderer/store/llm'
import type { Model } from '@renderer/types'
import { splitApiKeyString } from '@renderer/utils/api'
import { getLowerBaseModelName } from '@renderer/utils/naming'
import type { ModelPolicySnapshot } from '@shared/config/modelPolicy'
import { isZenContextCompactionApiHost } from '@shared/config/zenProvider'

import { getProviderContextHealthFingerprint } from './ProviderModelSyncUtils'

const logger = loggerService.withContext('RemoteModelPolicyClient')
// Refresh the static remote policy every five minutes. Context-model recovery
// is handled separately by the local model-test scheduler below.
const HEALTH_POLL_INTERVAL = 5 * 60 * 1000
const FOREGROUND_REFRESH_THRESHOLD = 5 * 60 * 1000
const CONTEXT_HEALTH_PROBE_TIMEOUT = 15 * 1000

let started = false
let lastRefreshAt = 0
let pendingSnapshot: ModelPolicySnapshot | null = null
let isApplying = false
let pendingProviderReconcile = false
let observedProviders = store.getState().llm.providers
let observedProviderFingerprints = new Map<string, string>(
  observedProviders.map((provider) => [provider.id, getProviderContextHealthFingerprint(provider)])
)
const pendingImmediateProbeProviderIds = new Set<string>()
const contextProbeScheduler = new ContextModelProbeScheduler()
let activeProbeSnapshot: ModelPolicySnapshot | null = null

const contextModelKey = (model: Model): string => `${model.provider}:${model.id}`.trim().toLowerCase()

const contextCompactionModelsFingerprint = (modelIds?: string[]): string =>
  JSON.stringify((modelIds ?? []).map((modelId) => getLowerBaseModelName(modelId.trim())))

const hasActiveWork = (state: RootState): boolean =>
  state.runtime.generating ||
  state.runtime.translating ||
  Object.values(state.messages.loadingByTopic).some(Boolean) ||
  Object.values(state.runtime.loadingMap).some(Boolean)

export const refreshRemoteModelPolicy = async (): Promise<ModelPolicySnapshot> => {
  const snapshot = await window.api.modelPolicy.refresh()
  activeProbeSnapshot = snapshot
  pendingSnapshot = snapshot
  tryApplyPendingPolicy()
  probeContextCompactionModels(snapshot)
  lastRefreshAt = Date.now()
  return snapshot
}

const refresh = async (): Promise<void> => {
  try {
    await refreshRemoteModelPolicy()
  } catch (error) {
    logger.warn('Failed to refresh remote model policy', error as Error)
  }
}

const canReplaceDefault = (
  current: Model | undefined,
  previousTarget: string | undefined,
  overwriteUserChoice: boolean
): boolean => {
  if (overwriteUserChoice) return true
  if (!current) return true
  const currentId = getLowerBaseModelName(current.id.trim())
  return Boolean(previousTarget && currentId === getLowerBaseModelName(previousTarget.trim()))
}

const preferredBeforeOutage = (slot: string, current: Model | undefined): Model | undefined => {
  const preferred = modelRecoveryIntents.get(`global:${slot}`)?.preferred
  return current && preferred ? { ...current, id: preferred.slice(preferred.indexOf(':') + 1) } : current
}

/**
 * Probe a locally frozen checkpoint model with the same model-test path used
 * by Provider settings. The API panel only receives the model name and the
 * default-group marker; model availability is decided by Zen AI itself.
 */
const probeContextCompactionModels = (snapshot: ModelPolicySnapshot, forceProviderIds = new Set<string>()): void => {
  activeProbeSnapshot = snapshot
  if (snapshot.source === 'builtin') {
    contextProbeScheduler.clear()
    return
  }
  // Keep each recovery check tied to its own five-minute expiry. If the
  // device is offline when a timer fires, the online event retries it once.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return

  const configuredModels = snapshot.policy.defaults.contextCompactionModels ?? []
  const providers = store.getState().llm.providers
  const consumedForceProviderIds = new Set<string>()
  for (const configuredModelId of configuredModels.slice(0, 3)) {
    const model = resolveIndependentModel(providers, configuredModelId)
    const provider = model ? providers.find((candidate) => candidate.id === model.provider) : undefined
    const forceProbe = provider ? forceProviderIds.has(provider.id) : false
    if (
      !model ||
      !provider ||
      !isContextCompactionTextModel(model) ||
      (!forceProbe && !isContextCompactionModelProbeDue(model)) ||
      !beginContextCompactionModelProbe(model, Date.now(), forceProbe)
    ) {
      continue
    }
    const probeToken = getContextCompactionModelProbeToken(model)
    if (probeToken === undefined) continue
    if (forceProbe) consumedForceProviderIds.add(provider.id)

    const apiKeys = splitApiKeyString(provider.apiKey)

    void (async () => {
      try {
        await checkModelWithAnyKey(
          provider,
          model,
          apiKeys,
          CONTEXT_HEALTH_PROBE_TIMEOUT,
          CONTEXT_COMPACTION_REQUEST_HEADERS,
          true
        )
        recordContextCompactionModelProbeSuccess(model, probeToken)
        logger.info('Context compaction model recovered after background probe', {
          modelId: model.id,
          providerId: model.provider
        })
      } catch (error) {
        if (isContextCompactionModelFailureFreezable(error)) {
          recordContextCompactionModelProbeFailure(model, probeToken)
        } else {
          releaseContextCompactionModelProbe(model, probeToken)
        }
        logger.warn('Context compaction model is still unavailable after background probe', error as Error, {
          modelId: model.id,
          providerId: model.provider
        })
      }
    })()
  }

  for (const providerId of consumedForceProviderIds) {
    pendingImmediateProbeProviderIds.delete(providerId)
  }

  scheduleContextModelProbes(snapshot)
}

/** Schedule a timer for each frozen model's exact recovery time. */
const scheduleContextModelProbes = (snapshot: ModelPolicySnapshot): void => {
  if (snapshot.source === 'builtin' || (typeof navigator !== 'undefined' && navigator.onLine === false)) return

  const providers = store.getState().llm.providers
  const candidates = (snapshot.policy.defaults.contextCompactionModels ?? [])
    .slice(0, 3)
    .map((modelId) => resolveIndependentModel(providers, modelId))
    .filter((model): model is Model => model !== undefined && isContextCompactionTextModel(model))
  const candidateKeys = new Set(candidates.map(contextModelKey))
  contextProbeScheduler.retain(candidateKeys)

  const now = Date.now()
  for (const model of candidates) {
    const key = contextModelKey(model)
    const dueAt = getContextCompactionModelUnavailableUntil(model)
    if (dueAt === undefined || !Number.isFinite(dueAt) || isContextCompactionModelProbeInFlight(model)) {
      contextProbeScheduler.cancel(key)
      continue
    }
    // A due model is probed by the caller before this scheduling pass. Offline
    // and foreground-resume paths call the probe pass directly as well.
    if (dueAt <= now) {
      contextProbeScheduler.cancel(key)
      continue
    }
    contextProbeScheduler.schedule(key, dueAt, () => {
      const currentSnapshot = activeProbeSnapshot ?? store.getState().llm.modelPolicy
      if (currentSnapshot) probeContextCompactionModels(currentSnapshot)
    })
  }
}

const applyRemoteDefaults = (state: RootState, snapshot: ModelPolicySnapshot): void => {
  if (snapshot.source === 'builtin') return
  const previous = state.llm.modelPolicy?.policy
  const policy = snapshot.policy
  // A remote policy is a release-level preference. Once that policy version
  // has been applied, refreshing the same version (or reconciling after a
  // Provider model sync) must not take a model chosen by the user back again.
  // `overwriteUserChoice` therefore only has an effect when a new policy
  // version is first applied.
  const isNewPolicyVersion = state.llm.remoteModelPolicyVersion !== snapshot.version
  const allowReleaseOverwrite = policy.rules.overwriteUserChoice && isNewPolicyVersion
  const defaultModel = resolveRemoteDefaultModel(state.llm.providers, policy.defaults.chat, state.llm.defaultModel)
  const quickModel = resolveRemoteDefaultModel(state.llm.providers, policy.defaults.quick, state.llm.quickModel)
  const translateModel = resolveRemoteDefaultModel(
    state.llm.providers,
    policy.defaults.translate,
    state.llm.translateModel
  )

  const nextDefaultModel =
    defaultModel &&
    canReplaceDefault(
      isNewPolicyVersion ? preferredBeforeOutage('chat', state.llm.defaultModel) : state.llm.defaultModel,
      previous?.defaults.chat,
      allowReleaseOverwrite
    )
      ? defaultModel
      : undefined
  const nextQuickModel =
    quickModel &&
    canReplaceDefault(
      isNewPolicyVersion ? preferredBeforeOutage('quick', state.llm.quickModel) : state.llm.quickModel,
      previous?.defaults.quick,
      allowReleaseOverwrite
    )
      ? quickModel
      : undefined
  const nextTranslateModel =
    translateModel &&
    canReplaceDefault(
      isNewPolicyVersion ? preferredBeforeOutage('translate', state.llm.translateModel) : state.llm.translateModel,
      previous?.defaults.translate,
      allowReleaseOverwrite
    )
      ? translateModel
      : undefined

  const isDifferentModel = (current: Model | undefined, next: Model | undefined) =>
    Boolean(next && (current?.id !== next.id || current.provider !== next.provider))

  if (
    state.llm.remoteModelPolicyVersion !== snapshot.version ||
    isDifferentModel(state.llm.defaultModel, nextDefaultModel) ||
    isDifferentModel(state.llm.quickModel, nextQuickModel) ||
    isDifferentModel(state.llm.translateModel, nextTranslateModel)
  ) {
    store.dispatch(
      applyRemoteModelPolicy({
        defaultModel: nextDefaultModel,
        quickModel: nextQuickModel,
        translateModel: nextTranslateModel,
        version: snapshot.version
      })
    )
  }
}

const resetContextHealthWhenPolicyChanges = (
  previous: ModelPolicySnapshot | undefined,
  next: ModelPolicySnapshot,
  providers: RootState['llm']['providers']
): void => {
  const previousModels = previous?.policy.defaults.contextCompactionModels
  const nextModels = next.policy.defaults.contextCompactionModels
  if (contextCompactionModelsFingerprint(previousModels) === contextCompactionModelsFingerprint(nextModels)) {
    return
  }

  // A model can disappear from and later return to the API-panel list while
  // keeping the same Provider. Clear its old five-minute freeze when the
  // policy itself changes; Provider credential changes are handled separately
  // by the Provider fingerprint reconciliation below.
  for (const provider of providers) {
    if (isZenContextCompactionApiHost(provider.apiHost)) {
      resetContextCompactionModelHealthForProvider(provider.id, provider.models)
    }
  }
}

const tryApplyPendingPolicy = (): void => {
  if (!pendingSnapshot || isApplying || hasActiveWork(store.getState())) return

  const snapshot = pendingSnapshot
  isApplying = true
  try {
    resetContextHealthWhenPolicyChanges(store.getState().llm.modelPolicy, snapshot, store.getState().llm.providers)
    applyRemoteDefaults(store.getState(), snapshot)
    store.dispatch(setModelPolicy(snapshot))
    pendingSnapshot = null
  } finally {
    isApplying = false
  }
}

export const reconcileRemoteModelPolicyDefaults = (): void => {
  if (isApplying || hasActiveWork(store.getState())) {
    pendingProviderReconcile = true
    return
  }

  const snapshot = store.getState().llm.modelPolicy
  if (!snapshot || snapshot.source === 'builtin') {
    pendingProviderReconcile = false
    return
  }

  isApplying = true
  try {
    applyRemoteDefaults(store.getState(), snapshot)
    pendingProviderReconcile = false
  } finally {
    isApplying = false
  }
}

export const startRemoteModelPolicySync = (): void => {
  if (started) return
  started = true

  observedProviders = store.getState().llm.providers
  observedProviderFingerprints = new Map(
    observedProviders.map((provider) => [provider.id, getProviderContextHealthFingerprint(provider)])
  )
  const unsubscribeStore = store.subscribe(() => {
    tryApplyPendingPolicy()

    const providers = store.getState().llm.providers
    if (providers !== observedProviders) {
      const changedProviderIds = new Set<string>()
      const nextProviderFingerprints = new Map<string, string>()

      for (const provider of providers) {
        const fingerprint = getProviderContextHealthFingerprint(provider)
        nextProviderFingerprints.set(provider.id, fingerprint)
        if (observedProviderFingerprints.get(provider.id) !== fingerprint) {
          changedProviderIds.add(provider.id)
          resetContextCompactionModelHealthForProvider(provider.id, provider.models)
        }
      }

      for (const providerId of observedProviderFingerprints.keys()) {
        if (!nextProviderFingerprints.has(providerId)) {
          resetContextCompactionModelHealthForProvider(providerId)
          pendingImmediateProbeProviderIds.delete(providerId)
        }
      }

      observedProviders = providers
      observedProviderFingerprints = nextProviderFingerprints
      pendingProviderReconcile = true

      const snapshot = store.getState().llm.modelPolicy
      for (const providerId of changedProviderIds) {
        pendingImmediateProbeProviderIds.add(providerId)
      }
      if (snapshot && pendingImmediateProbeProviderIds.size > 0) {
        probeContextCompactionModels(snapshot, pendingImmediateProbeProviderIds)
      }
    }

    if (pendingProviderReconcile && !hasActiveWork(store.getState())) {
      reconcileRemoteModelPolicyDefaults()
    }
  })
  const unsubscribeHealth = EventEmitter.on(EVENT_NAMES.CONTEXT_MODEL_HEALTH_UPDATED, () => {
    const snapshot = activeProbeSnapshot ?? store.getState().llm.modelPolicy
    if (snapshot) probeContextCompactionModels(snapshot, pendingImmediateProbeProviderIds)
  })
  void refresh()

  const interval = window.setInterval(() => void refresh(), HEALTH_POLL_INTERVAL)
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      const snapshot = activeProbeSnapshot ?? store.getState().llm.modelPolicy
      if (snapshot) probeContextCompactionModels(snapshot, pendingImmediateProbeProviderIds)
      if (Date.now() - lastRefreshAt >= FOREGROUND_REFRESH_THRESHOLD) void refresh()
    }
  }
  const onOnline = () => {
    const snapshot = activeProbeSnapshot ?? store.getState().llm.modelPolicy
    if (snapshot) probeContextCompactionModels(snapshot, pendingImmediateProbeProviderIds)
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('online', onOnline)
  window.addEventListener('beforeunload', () => {
    window.clearInterval(interval)
    contextProbeScheduler.clear()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('online', onOnline)
    unsubscribeStore()
    unsubscribeHealth()
    pendingSnapshot = null
    activeProbeSnapshot = null
    pendingProviderReconcile = false
    pendingImmediateProbeProviderIds.clear()
    observedProviderFingerprints = new Map()
    started = false
  })
}
