import { resolveIndependentModel } from '@renderer/config/remoteModelPolicy'
import type { Model, Provider } from '@renderer/types'
import { getLowerBaseModelName } from '@renderer/utils/naming'
import type { ContextCompactionModelHealthMap } from '@shared/config/modelPolicy'

import {
  isContextCompactionModelCoolingDown,
  recordContextCompactionModelFailure,
  recordContextCompactionModelSuccess
} from './ContextCompactionModelHealthService'

// The API panel uses this marker to route auxiliary checkpoint generation to
// the exact `default` channel group. It is deliberately sent only for
// context-compaction requests; ordinary chat and agent traffic is unchanged.
export const CONTEXT_COMPACTION_REQUEST_HEADERS = {
  'X-Zen-Context-Compaction': 'default-only'
} as const

export type ResolveContextCompactionModelsOptions = {
  providers: Provider[]
  /** Undefined means the server has not published this setting yet. */
  configuredModelIds?: string[]
  health?: ContextCompactionModelHealthMap
  currentModel?: Model
}

export type ContextCompactionGenerator = (prompt: string, content: string) => Promise<string>

export type CreateContextCompactionGeneratorOptions = {
  models: Model[]
  generate: (model: Model, prompt: string, content: string) => Promise<string>
  shouldTryNext?: (error: unknown) => boolean
  onModelFailure?: (model: Model, error: unknown, nextPosition: number) => void
  onModelSuccess?: (model: Model) => void
  onExhausted?: (models: Model[]) => void
}

/**
 * Resolve the ordered model list used only for checkpoint generation.
 *
 * Older remote policies do not contain this field, so they retain the
 * previous behavior and use the current conversation model. Once the field
 * exists, only the explicitly configured models are considered; if none of
 * them can be resolved, the caller can immediately use its deterministic
 * local checkpoint fallback instead of silently using an unrelated model.
 */
export const resolveContextCompactionModels = ({
  providers,
  configuredModelIds,
  health,
  currentModel
}: ResolveContextCompactionModelsOptions): Model[] => {
  if (configuredModelIds === undefined) {
    return currentModel ? [currentModel] : []
  }

  const resolved: Model[] = []
  const seen = new Set<string>()

  for (const modelId of configuredModelIds.slice(0, 3)) {
    const target = modelId.trim()
    if (!target) continue

    const normalizedTarget = getLowerBaseModelName(target)
    const targetHealth =
      health?.[target] ??
      Object.entries(health ?? {}).find(([model]) => getLowerBaseModelName(model) === normalizedTarget)?.[1]
    if (targetHealth?.status === 'unavailable') continue

    const model = resolveIndependentModel(providers, target, currentModel)
    if (!model) continue

    if (isContextCompactionModelCoolingDown(model)) continue

    const key = `${model.provider}:${model.id}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    resolved.push(model)
  }

  return resolved
}

/**
 * Create one sticky ordered fallback chain for a single checkpoint operation.
 * Once a model fails, later chunks start at the next model instead of retrying
 * the failed one. The generator throws only after every configured candidate
 * fails; the context service then performs its deterministic local fallback.
 */
export const createContextCompactionGenerator = ({
  models,
  generate,
  shouldTryNext = () => true,
  onModelFailure,
  onModelSuccess,
  onExhausted
}: CreateContextCompactionGeneratorOptions): ContextCompactionGenerator => {
  let modelIndex = 0

  return async (prompt, content) => {
    while (modelIndex < models.length) {
      const model = models[modelIndex]
      try {
        const result = await generate(model, prompt, content)
        if (result.trim()) {
          recordContextCompactionModelSuccess(model)
          onModelSuccess?.(model)
          return result
        }
        throw new Error('Context checkpoint model returned empty output.')
      } catch (error) {
        if (!shouldTryNext(error)) {
          throw error
        }
        recordContextCompactionModelFailure(model)
        modelIndex += 1
        onModelFailure?.(model, error, modelIndex + 1)
      }
    }

    onExhausted?.(models)
    throw new Error('All configured context checkpoint models failed.')
  }
}
