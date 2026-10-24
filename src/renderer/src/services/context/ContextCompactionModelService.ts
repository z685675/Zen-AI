import { isDedicatedImageGenerationModel, isEmbeddingModel, isRerankModel } from '@renderer/config/models'
import { resolveIndependentModel } from '@renderer/config/remoteModelPolicy'
import type { Model, Provider } from '@renderer/types'
import { isAbortError } from '@renderer/utils/error'
import { getModelDailyQuotaErrorKind } from '@shared/utils/modelDailyQuota'

import { getErrorStatusCode } from '../chatKeyFailover'
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

/** Models that cannot produce ordinary text are never checkpoint candidates. */
export const isContextCompactionTextModel = (model: Model): boolean =>
  !isEmbeddingModel(model) && !isRerankModel(model) && !isDedicatedImageGenerationModel(model)

export type ResolveContextCompactionModelsOptions = {
  providers: Provider[]
  /** Missing or empty means the local checkpoint fallback is used. */
  configuredModelIds?: string[]
  currentModel?: Model
}

export type ContextCompactionGenerator = ((prompt: string, content: string) => Promise<string>) & {
  /** Mark the last model output healthy only after the final checkpoint passes integrity checks. */
  markLastModelSuccess?: () => void
  /** Freeze the last model output when the final checkpoint fails integrity checks. */
  markLastModelFailure?: (error: unknown) => void
}

export type CreateContextCompactionGeneratorOptions = {
  models: Model[]
  generate: (model: Model, prompt: string, content: string) => Promise<string>
  /** Validate each model result before it can be used by a later merge step. */
  validateOutput?: (output: string, prompt: string, content: string) => boolean
  shouldTryNext?: (error: unknown) => boolean
  shouldFreezeModel?: (error: unknown) => boolean
  onModelFailure?: (model: Model, error: unknown, nextPosition: number) => void
  onModelSuccess?: (model: Model) => void
  onExhausted?: (models: Model[]) => void
}

/**
 * Resolve the ordered model list used only for checkpoint generation.
 *
 * Only explicitly configured models from the managed Provider are considered.
 * If the API panel has not published this field yet, or has published an
 * empty list, the caller can immediately use its deterministic local
 * checkpoint fallback instead of silently using an unrelated model.
 */
export const resolveContextCompactionModels = ({
  providers,
  configuredModelIds,
  currentModel
}: ResolveContextCompactionModelsOptions): Model[] => {
  if (!configuredModelIds || configuredModelIds.length === 0) return []

  const resolved: Model[] = []
  const seen = new Set<string>()

  for (const modelId of configuredModelIds.slice(0, 3)) {
    const target = modelId.trim()
    if (!target) continue

    const model = resolveIndependentModel(providers, target, currentModel)
    if (!model || !isContextCompactionTextModel(model)) continue

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
  validateOutput,
  shouldTryNext = () => true,
  shouldFreezeModel = isContextCompactionModelFailureFreezable,
  onModelFailure,
  onModelSuccess,
  onExhausted
}: CreateContextCompactionGeneratorOptions): ContextCompactionGenerator => {
  let modelIndex = 0
  let lastSuccessfulModel: Model | undefined

  const generator = (async (prompt: string, content: string) => {
    while (modelIndex < models.length) {
      const model = models[modelIndex]
      try {
        const result = await generate(model, prompt, content)
        const normalizedResult = result.trim()
        if (normalizedResult && (!validateOutput || validateOutput(normalizedResult, prompt, content))) {
          // Do not mark a model healthy yet. The caller still has to validate
          // the complete checkpoint; a non-empty but incomplete summary must
          // freeze the model just like a transport failure.
          lastSuccessfulModel = model
          return normalizedResult
        }
        throw new Error(
          normalizedResult
            ? 'Context checkpoint model returned an invalid checkpoint.'
            : 'Context checkpoint model returned empty output.'
        )
      } catch (error) {
        if (!shouldTryNext(error)) {
          throw error
        }
        if (shouldFreezeModel(error)) {
          recordContextCompactionModelFailure(model)
        }
        lastSuccessfulModel = undefined
        modelIndex += 1
        onModelFailure?.(model, error, modelIndex + 1)
      }
    }

    onExhausted?.(models)
    throw new Error('All configured context checkpoint models failed.')
  }) as ContextCompactionGenerator

  generator.markLastModelSuccess = () => {
    if (!lastSuccessfulModel) return
    recordContextCompactionModelSuccess(lastSuccessfulModel)
    onModelSuccess?.(lastSuccessfulModel)
    lastSuccessfulModel = undefined
  }

  generator.markLastModelFailure = (error: unknown) => {
    if (!lastSuccessfulModel) return
    if (shouldFreezeModel(error)) {
      recordContextCompactionModelFailure(lastSuccessfulModel)
    }
    lastSuccessfulModel = undefined
  }

  return generator
}

/**
 * User cancellation and confirmed device-offline errors should not blacklist
 * a healthy remote model. Other failures are treated as model/service health
 * failures and are frozen for the local five-minute recovery cycle.
 */
export const isContextCompactionModelFailureFreezable = (error: unknown): boolean => {
  if (getModelDailyQuotaErrorKind(error)) return false
  if (isAbortError(error)) return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false

  // An explicit HTTP response proves that the request reached a service or
  // route. Treat that as a model/service failure, even when its message also
  // contains a generic network phrase.
  const statusCode = getErrorStatusCode(error)
  if (statusCode !== undefined && statusCode >= 100 && statusCode <= 599) return true

  const networkText = collectErrorText(error).toLowerCase()
  if (!networkText) return true

  // Browser/Electron fetch errors have no HTTP status. Explicitly local
  // connectivity failures should not blacklist an otherwise healthy
  // checkpoint model. Timeouts are intentionally not in this list: a
  // context request is bounded by our own timeout and a timed-out upstream
  // model must be frozen so the next checkpoint does not keep retrying it.
  if (
    /failed to fetch|fetch failed|networkerror|load failed|err_network|err_internet_disconnected|err_network_changed|err_network_io_suspended|err_connection_aborted|err_connection_refused|econnreset|enotfound|dns|socket hang up|connection (?:reset|closed|aborted|refused)/.test(
      networkText
    )
  ) {
    return false
  }

  return true
}

const collectErrorText = (error: unknown): string => {
  const values: string[] = []
  const visited = new Set<unknown>()
  let current: unknown = error

  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (visited.has(current)) break
    visited.add(current)

    if (typeof current === 'string') {
      values.push(current)
      break
    }

    if (typeof current !== 'object') break
    const record = current as Record<string, unknown>
    for (const key of ['name', 'message', 'code', 'error', 'reason', 'details']) {
      const value = record[key]
      if (typeof value === 'string') values.push(value)
      else if (value && typeof value === 'object') {
        try {
          values.push(JSON.stringify(value))
        } catch {
          // Ignore an unserializable nested error field.
        }
      }
    }
    current = record.cause
  }

  return values.join(' ')
}
