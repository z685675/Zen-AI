import type { AgentConfiguration, ApiModel } from '@renderer/types'
import type { ModelPolicy, ModelPolicySnapshot } from '@shared/config/modelPolicy'

export const STANDARD_AGENT_MODEL_IDS = ['gpt-5.6-luna', 'grok-4.5', 'gemini-3-flash-preview'] as const

const standardAgentModelIds = new Set<string>(STANDARD_AGENT_MODEL_IDS)

const REMOTE_DEFAULT_POLICY_VERSION_KEY = 'remote_default_model_policy_version'
const REMOTE_DEFAULT_POLICY_TARGET_KEY = 'remote_default_model_policy_target'

export const getAppliedAgentDefaultPolicyVersion = (configuration?: AgentConfiguration): number => {
  const version = configuration?.[REMOTE_DEFAULT_POLICY_VERSION_KEY]
  return typeof version === 'number' && Number.isInteger(version) ? version : 0
}

export const getAppliedAgentDefaultPolicyTarget = (configuration?: AgentConfiguration): string | undefined => {
  const target = configuration?.[REMOTE_DEFAULT_POLICY_TARGET_KEY]
  return typeof target === 'string' && target.trim() ? target : undefined
}

export const markAgentDefaultPolicyApplied = (
  configuration: AgentConfiguration | undefined,
  snapshot: ModelPolicySnapshot | undefined
): AgentConfiguration | undefined => {
  if (!snapshot || snapshot.source === 'builtin') return configuration

  return {
    ...configuration,
    permission_mode: configuration?.permission_mode ?? 'default',
    max_turns: configuration?.max_turns ?? 100,
    env_vars: configuration?.env_vars ?? {},
    [REMOTE_DEFAULT_POLICY_VERSION_KEY]: snapshot.version,
    [REMOTE_DEFAULT_POLICY_TARGET_KEY]: snapshot.policy.defaults.assistantNewSession
  }
}

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

const getModelIdentifiers = (model: ApiModel): string[] =>
  [model.provider_model_id, model.id, model.name].filter((identifier): identifier is string => Boolean(identifier))

const matchesPolicyModel = (identifier: string, modelIds: string[]): boolean => {
  const normalizedIdentifier = normalizeAgentModelIdentifier(identifier)
  return modelIds.some((modelId) => normalizeAgentModelIdentifier(modelId) === normalizedIdentifier)
}

export const isAssistantModelBlocked = (model: ApiModel, policy?: ModelPolicy): boolean => {
  if (!policy) return false
  return getModelIdentifiers(model).some((identifier) => isAssistantModelIdentifierBlocked(identifier, policy))
}

export const isAssistantModelIdentifierBlocked = (modelId: string | undefined, policy?: ModelPolicy): boolean => {
  if (!modelId || !policy) return false
  return policy.assistant.blockedModels.some(
    (blocked) => normalizeAgentModelIdentifier(blocked) === normalizeAgentModelIdentifier(modelId)
  )
}

export const isAssistantModelAllowed = (model: ApiModel, developerMode: boolean, policy?: ModelPolicy): boolean => {
  if (isAssistantModelBlocked(model, policy)) return false

  if (!policy) return developerMode || isStandardAgentModel(model)
  if (developerMode && policy.rules.developerModeBypassAllowlist) return true

  const allowlist = developerMode ? policy.assistant.developerAllowlist : policy.assistant.nonDeveloperAllowlist
  if (allowlist.length > 0) {
    return getModelIdentifiers(model).some((identifier) => matchesPolicyModel(identifier, allowlist))
  }

  return isStandardAgentModel(model)
}

export const isAssistantModelIdentifierAllowed = (
  modelId: string | undefined,
  developerMode: boolean,
  policy?: ModelPolicy
): boolean => {
  if (!modelId) return false
  const normalizedModelId = normalizeAgentModelIdentifier(modelId)
  if (isAssistantModelIdentifierBlocked(modelId, policy)) return false
  if (!policy) return developerMode || isStandardAgentModelIdentifier(modelId)
  if (developerMode && policy.rules.developerModeBypassAllowlist) return true

  const allowlist = developerMode ? policy.assistant.developerAllowlist : policy.assistant.nonDeveloperAllowlist
  return allowlist.length > 0
    ? allowlist.some((allowed) => normalizeAgentModelIdentifier(allowed) === normalizedModelId)
    : isStandardAgentModelIdentifier(modelId)
}

export const getAgentModelProviderId = (modelId: string | undefined): string | undefined => {
  if (!modelId) return undefined
  const separatorIndex = modelId.indexOf(':')
  return separatorIndex > 0 ? modelId.slice(0, separatorIndex) : undefined
}

export const findAgentModelId = (
  models: ApiModel[],
  targetModelId: string,
  preferredProviderId?: string
): string | undefined => {
  const exactMatch = models.find((model) => model.id.toLowerCase() === targetModelId.trim().toLowerCase())
  if (exactMatch) return exactMatch.id

  const normalizedTarget = normalizeAgentModelIdentifier(targetModelId)
  const candidates = models.filter((model) =>
    [model.provider_model_id, model.id, model.name]
      .filter((identifier): identifier is string => Boolean(identifier))
      .some((identifier) => normalizeAgentModelIdentifier(identifier) === normalizedTarget)
  )

  if (preferredProviderId) {
    const preferredMatch = candidates.find((model) => model.provider === preferredProviderId)
    if (preferredMatch) return preferredMatch.id
  }

  return candidates.find((model) => model.is_official_provider)?.id ?? candidates[0]?.id
}
