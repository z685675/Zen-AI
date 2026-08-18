import type { Model, Provider } from '@renderer/types'
import { getLowerBaseModelName } from '@renderer/utils/naming'
import { isZenManagedApiHost } from '@shared/config/zenProvider'

type ModelCandidate = {
  model: Model
  provider: Provider
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

  const normalizedTarget = getLowerBaseModelName(target.trim())
  const candidates: ModelCandidate[] = providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      (provider.models ?? [])
        .filter((model) => getLowerBaseModelName(model.id.trim()) === normalizedTarget)
        .map((model) => ({ model, provider }))
    )

  if (candidates.length === 0) return undefined

  if (current?.provider) {
    const currentProviderCandidate = candidates.find(({ provider }) => provider.id === current.provider)
    if (currentProviderCandidate) return currentProviderCandidate.model
  }

  return candidates.find(({ provider }) => isZenManagedApiHost(provider.apiHost))?.model ?? candidates[0].model
}
