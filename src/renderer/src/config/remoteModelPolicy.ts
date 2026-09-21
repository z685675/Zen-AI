import type { Model, Provider } from '@renderer/types'
import { getLowerBaseModelName } from '@renderer/utils/naming'
import { isZenManagedApiHost } from '@shared/config/zenProvider'

type ModelCandidate = {
  model: Model
  provider: Provider
}

const getModelCandidates = (providers: Provider[], target: string): ModelCandidate[] => {
  const normalizedTarget = getLowerBaseModelName(target.trim())
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      (provider.models ?? [])
        .filter((model) => getLowerBaseModelName(model.id.trim()) === normalizedTarget)
        .map((model) => ({ model, provider }))
    )
}

/**
 * Resolve a remotely configured model without making the selected Provider depend
 * on Redux ordering. Existing Provider affinity wins, then Zen AI's managed
 * Provider, followed by the first enabled Provider exposing the model.
 */
export const resolveRemoteDefaultModel = (
  providers: Provider[],
  target: string | undefined,
  current?: Model
): Model | undefined => {
  if (!target?.trim()) return undefined

  const candidates = getModelCandidates(providers, target)

  if (candidates.length === 0) return undefined

  if (current?.provider) {
    const currentProviderCandidate = candidates.find(({ provider }) => provider.id === current.provider)
    if (currentProviderCandidate) return currentProviderCandidate.model
  }

  return candidates.find(({ provider }) => isZenManagedApiHost(provider.apiHost))?.model ?? candidates[0].model
}

/**
 * Resolve an auxiliary context model without inheriting the active chat
 * provider when another enabled provider exposes the same model. Context
 * checkpointing must remain useful when the user's current chat provider is
 * degraded, so provider affinity is deliberately reversed here.
 */
export const resolveIndependentModel = (
  providers: Provider[],
  target: string | undefined,
  current?: Model
): Model | undefined => {
  if (!target?.trim()) return undefined

  const candidates = getModelCandidates(providers, target)
  if (candidates.length === 0) return undefined

  const independentCandidates = current?.provider
    ? candidates.filter(({ provider }) => provider.id !== current.provider)
    : candidates
  const preferredCandidates = independentCandidates.length > 0 ? independentCandidates : candidates

  return (
    preferredCandidates.find(({ provider }) => isZenManagedApiHost(provider.apiHost))?.model ??
    preferredCandidates[0].model
  )
}
