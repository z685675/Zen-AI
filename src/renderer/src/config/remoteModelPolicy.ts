import type { Model, Provider } from '@renderer/types'
import { getLowerBaseModelName } from '@renderer/utils/naming'
import { isZenContextCompactionApiHost, isZenManagedApiHost } from '@shared/config/zenProvider'

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

  const candidates = getModelCandidates(providers, target).filter(({ provider }) =>
    isZenContextCompactionApiHost(provider.apiHost)
  )
  if (candidates.length === 0) return undefined

  // `Model.group` is a client-side display/vendor grouping. It is not the
  // API panel's channel routing group. Models returned by a New API/OpenAI
  // compatible `/models` endpoint commonly have no group and are normalized
  // locally to the Provider id, even when the server can route them through
  // the `default` channel group. The auxiliary request carries the explicit
  // default-only routing marker; do not reject the model here based on this
  // unrelated client field.
  const managedCandidates = candidates

  const independentCandidates = current?.provider
    ? managedCandidates.filter(({ provider }) => provider.id !== current.provider)
    : managedCandidates
  const preferredCandidates = independentCandidates.length > 0 ? independentCandidates : managedCandidates

  return preferredCandidates[0].model
}
