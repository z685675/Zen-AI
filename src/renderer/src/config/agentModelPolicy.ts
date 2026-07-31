import type { ApiModel } from '@renderer/types'

export const STANDARD_AGENT_MODEL_IDS = ['gpt-5.6-luna', 'grok-4.5', 'gemini-3-flash-preview'] as const

const standardAgentModelIds = new Set<string>(STANDARD_AGENT_MODEL_IDS)

export const normalizeAgentModelIdentifier = (identifier: string): string => {
  const normalized = identifier.trim().toLowerCase()
  const withoutProvider = normalized.includes(':') ? normalized.slice(normalized.indexOf(':') + 1) : normalized
  const pathParts = withoutProvider.split('/').filter(Boolean)

  return pathParts.at(-1) ?? withoutProvider
}

export const isStandardAgentModel = (model: ApiModel): boolean => {
  const identifiers = [model.provider_model_id, model.id, model.name].filter((identifier): identifier is string =>
    Boolean(identifier)
  )

  return identifiers.some(isStandardAgentModelIdentifier)
}

export const isStandardAgentModelIdentifier = (modelId: string | undefined): boolean =>
  Boolean(modelId && standardAgentModelIds.has(normalizeAgentModelIdentifier(modelId)))

export const findAgentModelId = (models: ApiModel[], targetModelId: string): string | undefined => {
  const normalizedTarget = normalizeAgentModelIdentifier(targetModelId)
  return models.find((model) =>
    [model.provider_model_id, model.id, model.name]
      .filter((identifier): identifier is string => Boolean(identifier))
      .some((identifier) => normalizeAgentModelIdentifier(identifier) === normalizedTarget)
  )?.id
}
