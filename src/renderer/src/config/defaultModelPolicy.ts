import type { Model, Provider } from '@renderer/types'
import { getLowerBaseModelName } from '@renderer/utils/naming'

export const CURRENT_DEFAULT_MODEL_ID = 'gpt-5.6-luna'
export const CURRENT_DEFAULT_MODEL_POLICY_VERSION = 1

export interface CurrentDefaultModels {
  defaultModel?: Model
  quickModel?: Model
  translateModel?: Model
}

export function getCurrentDefaultModels(models: Model[]): CurrentDefaultModels {
  const model = models.find((candidate) => getLowerBaseModelName(candidate.id.trim()) === CURRENT_DEFAULT_MODEL_ID)

  return {
    defaultModel: model,
    quickModel: model,
    translateModel: model
  }
}

export function isCurrentDefaultModelPolicyApplied(appliedVersion?: number): boolean {
  return (appliedVersion ?? 0) >= CURRENT_DEFAULT_MODEL_POLICY_VERSION
}

export function getPendingCurrentDefaultModels(
  providers: Provider[],
  appliedVersion?: number
): CurrentDefaultModels | undefined {
  if (isCurrentDefaultModelPolicyApplied(appliedVersion)) {
    return undefined
  }

  const enabledModels = providers.filter((provider) => provider.enabled).flatMap((provider) => provider.models ?? [])
  const defaults = getCurrentDefaultModels(enabledModels)
  return defaults.defaultModel ? defaults : undefined
}
