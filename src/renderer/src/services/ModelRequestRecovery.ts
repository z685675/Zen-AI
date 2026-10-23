import { isAssistantModelIdentifierBlocked } from '@renderer/config/agentModelPolicy'
import type { Model, Provider } from '@renderer/types'
import type { ModelPolicy } from '@shared/config/modelPolicy'
import { isTextFallbackIdentifier, selectRecoverableModel } from '@shared/config/modelRecovery'
import { isZenManagedApiHost } from '@shared/config/zenProvider'

import { modelRecoveryIntents } from './modelRecoveryIntents'

/** Resolve a NEW auxiliary request without rewriting settings used by an
 * already-running turn. Never retry/replay that turn or cross Providers. */
export function resolveNextManagedRequestModel(
  slot: string,
  current: Model | undefined,
  providers: Provider[],
  policy?: ModelPolicy
): Model | undefined {
  if (!current || !isTextFallbackIdentifier(current.id)) return current
  const provider = providers.find((entry) => entry.id === current.provider)
  if (!provider || !isZenManagedApiHost(provider.apiHost)) return current
  if (!provider.enabled) return undefined
  const models = provider.models.filter(
    (model) =>
      isTextFallbackIdentifier(model.id) &&
      model.endpoint_type !== 'image-generation' &&
      model.endpoint_type !== 'jina-rerank' &&
      !isAssistantModelIdentifierBlocked(model.id, policy)
  )
  const key = (model: Model) => `${model.provider}:${model.id}`
  const result = selectRecoverableModel({
    current: key(current),
    intent: modelRecoveryIntents.get(slot),
    available: models.map(key),
    fallbacks: (policy?.assistant.fallbackModels ?? [])
      .filter(isTextFallbackIdentifier)
      .map((id) => `${provider.id}:${id}`),
    now: Date.now()
  })
  return models.find((model) => key(model) === result.selected)
}
