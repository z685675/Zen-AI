import { loggerService } from '@logger'
import { resolveRemoteDefaultModel } from '@renderer/config/remoteModelPolicy'
import store, { type RootState } from '@renderer/store'
import { applyRemoteModelPolicy, setModelPolicy } from '@renderer/store/llm'
import type { Model } from '@renderer/types'
import { getLowerBaseModelName } from '@renderer/utils/naming'
import type { ModelPolicySnapshot } from '@shared/config/modelPolicy'

const logger = loggerService.withContext('RemoteModelPolicyClient')
const POLL_INTERVAL = 30 * 60 * 1000
const FOREGROUND_REFRESH_THRESHOLD = 15 * 60 * 1000

let started = false
let lastRefreshAt = 0
let pendingSnapshot: ModelPolicySnapshot | null = null
let isApplying = false
let pendingProviderReconcile = false
let observedProviders = store.getState().llm.providers

const hasActiveWork = (state: RootState): boolean =>
  state.runtime.generating ||
  state.runtime.translating ||
  Object.values(state.messages.loadingByTopic).some(Boolean) ||
  Object.values(state.runtime.loadingMap).some(Boolean)

export const refreshRemoteModelPolicy = async (): Promise<ModelPolicySnapshot> => {
  const snapshot = await window.api.modelPolicy.refresh()
  pendingSnapshot = snapshot
  tryApplyPendingPolicy()
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

const applyRemoteDefaults = (state: RootState, snapshot: ModelPolicySnapshot): void => {
  if (snapshot.source === 'builtin') return
  const previous = state.llm.modelPolicy?.policy
  const policy = snapshot.policy
  const defaultModel = resolveRemoteDefaultModel(state.llm.providers, policy.defaults.chat, state.llm.defaultModel)
  const quickModel = resolveRemoteDefaultModel(state.llm.providers, policy.defaults.quick, state.llm.quickModel)
  const translateModel = resolveRemoteDefaultModel(
    state.llm.providers,
    policy.defaults.translate,
    state.llm.translateModel
  )

  const nextDefaultModel =
    defaultModel && canReplaceDefault(state.llm.defaultModel, previous?.defaults.chat, policy.rules.overwriteUserChoice)
      ? defaultModel
      : undefined
  const nextQuickModel =
    quickModel && canReplaceDefault(state.llm.quickModel, previous?.defaults.quick, policy.rules.overwriteUserChoice)
      ? quickModel
      : undefined
  const nextTranslateModel =
    translateModel &&
    canReplaceDefault(state.llm.translateModel, previous?.defaults.translate, policy.rules.overwriteUserChoice)
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

const tryApplyPendingPolicy = (): void => {
  if (!pendingSnapshot || isApplying || hasActiveWork(store.getState())) return

  const snapshot = pendingSnapshot
  isApplying = true
  try {
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
  const unsubscribeStore = store.subscribe(() => {
    tryApplyPendingPolicy()

    const providers = store.getState().llm.providers
    if (providers !== observedProviders) {
      observedProviders = providers
      pendingProviderReconcile = true
    }

    if (pendingProviderReconcile && !hasActiveWork(store.getState())) {
      reconcileRemoteModelPolicyDefaults()
    }
  })
  void refresh()

  const interval = window.setInterval(() => void refresh(), POLL_INTERVAL)
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastRefreshAt >= FOREGROUND_REFRESH_THRESHOLD) {
      void refresh()
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('beforeunload', () => {
    window.clearInterval(interval)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    unsubscribeStore()
    pendingSnapshot = null
    pendingProviderReconcile = false
    started = false
  })
}
