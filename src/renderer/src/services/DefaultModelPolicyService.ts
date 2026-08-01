import { loggerService } from '@logger'
import {
  CURRENT_DEFAULT_MODEL_POLICY_VERSION,
  getPendingCurrentDefaultModels,
  isCurrentDefaultModelPolicyApplied
} from '@renderer/config/defaultModelPolicy'
import store from '@renderer/store'
import { applyDefaultModelPolicy } from '@renderer/store/llm'

const logger = loggerService.withContext('DefaultModelPolicyService')

let unsubscribe: (() => void) | undefined

function stopWatching(): void {
  unsubscribe?.()
  unsubscribe = undefined
}

function tryApplyCurrentDefaultModelPolicy(): boolean {
  const state = store.getState()
  const defaults = getPendingCurrentDefaultModels(state.llm.providers, state.llm.defaultModelPolicyVersion)
  const model = defaults?.defaultModel

  if (!model) {
    return false
  }

  store.dispatch(
    applyDefaultModelPolicy({
      model,
      version: CURRENT_DEFAULT_MODEL_POLICY_VERSION
    })
  )
  logger.info('Applied current default model policy', { modelId: model.id, providerId: model.provider })
  return true
}

export function startDefaultModelPolicyReconciler(): void {
  if (unsubscribe || isCurrentDefaultModelPolicyApplied(store.getState().llm.defaultModelPolicyVersion)) {
    return
  }

  if (tryApplyCurrentDefaultModelPolicy()) {
    return
  }

  unsubscribe = store.subscribe(() => {
    if (isCurrentDefaultModelPolicyApplied(store.getState().llm.defaultModelPolicyVersion)) {
      stopWatching()
      return
    }

    if (tryApplyCurrentDefaultModelPolicy()) {
      stopWatching()
    }
  })
}
