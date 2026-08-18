import { loggerService } from '@logger'
import { CURRENT_DEFAULT_MODEL_ID } from '@renderer/config/defaultModelPolicy'
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
  if (currentId === CURRENT_DEFAULT_MODEL_ID) return true
  return Boolean(previousTarget && currentId === getLowerBaseModelName(previousTarget.trim()))
}

const applyRemoteDefaults = (state: RootState, snapshot: ModelPolicySnapshot): boolean => {
  if (
    state.llm.remoteModelPolicyVersion &&
    state.llm.remoteModelPolicyVersion >= snapshot.version &&
    state.llm.modelPolicy?.version &&
    state.llm.modelPolicy.version >= snapshot.version
  ) {
    return true
  }

  const previous = state.llm.modelPolicy?.policy
  const policy = snapshot.policy
  const defaultModel = resolveRemoteDefaultModel(state.llm.providers, policy.defaults.chat, state.llm.defaultModel)
  const quickModel = resolveRemoteDefaultModel(state.llm.providers, policy.defaults.quick, state.llm.quickModel)
  const translateModel = resolveRemoteDefaultModel(
    state.llm.providers,
    policy.defaults.translate,
    state.llm.translateModel
  )

  store.dispatch(
    applyRemoteModelPolicy({
      defaultModel:
        defaultModel &&
        canReplaceDefault(state.llm.defaultModel, previous?.defaults.chat, policy.rules.overwriteUserChoice)
          ? defaultModel
          : undefined,
      quickModel:
        quickModel &&
        canReplaceDefault(state.llm.quickModel, previous?.defaults.quick, policy.rules.overwriteUserChoice)
          ? quickModel
          : undefined,
      translateModel:
        translateModel &&
        canReplaceDefault(state.llm.translateModel, previous?.defaults.translate, policy.rules.overwriteUserChoice)
          ? translateModel
          : undefined,
      version: snapshot.version
    })
  )
  return true
}

const tryApplyPendingPolicy = (): void => {
  if (!pendingSnapshot || isApplying || hasActiveWork(store.getState())) return

  const snapshot = pendingSnapshot
  const state = store.getState()
  if (
    state.llm.remoteModelPolicyVersion &&
    state.llm.remoteModelPolicyVersion >= snapshot.version &&
    state.llm.modelPolicy?.version &&
    state.llm.modelPolicy.version >= snapshot.version
  ) {
    pendingSnapshot = null
    return
  }

  isApplying = true
  try {
    if (!applyRemoteDefaults(state, snapshot)) return
    store.dispatch(setModelPolicy(snapshot))
    pendingSnapshot = null
  } finally {
    isApplying = false
  }
}

export const startRemoteModelPolicySync = (): void => {
  if (started) return
  started = true

  const unsubscribeStore = store.subscribe(tryApplyPendingPolicy)
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
    started = false
  })
}
