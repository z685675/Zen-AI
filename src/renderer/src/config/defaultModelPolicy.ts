import type { Model, Provider } from '@renderer/types'

/**
 * Legacy compatibility shim.
 *
 * Model defaults are now owned by the remotely fetched policy. The client must
 * never wait for, or force, a model identifier compiled into the application.
 */
export const CURRENT_DEFAULT_MODEL_POLICY_VERSION = 0

export interface CurrentDefaultModels {
  defaultModel?: Model
  quickModel?: Model
  translateModel?: Model
}

export function getCurrentDefaultModels(_models: Model[]): CurrentDefaultModels {
  void _models
  return {}
}

export function isCurrentDefaultModelPolicyApplied(appliedVersion?: number): boolean {
  return (appliedVersion ?? 0) >= CURRENT_DEFAULT_MODEL_POLICY_VERSION
}

export function getPendingCurrentDefaultModels(
  _providers: Provider[],
  _appliedVersion?: number
): CurrentDefaultModels | undefined {
  void _providers
  void _appliedVersion
  return undefined
}
