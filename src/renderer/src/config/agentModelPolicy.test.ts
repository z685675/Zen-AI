import type { ApiModel } from '@renderer/types'
import type { ModelPolicy } from '@shared/config/modelPolicy'
import { describe, expect, it } from 'vitest'

import {
  findAgentModelId,
  isAssistantModelAllowed,
  isAssistantModelBlocked,
  isAssistantModelIdentifierAllowed,
  isAssistantModelIdentifierBlocked,
  isStandardAgentModel,
  isStandardAgentModelIdentifier,
  normalizeAgentModelIdentifier,
  STANDARD_AGENT_MODEL_IDS
} from './agentModelPolicy'

const createApiModel = (overrides: Partial<ApiModel> = {}): ApiModel => ({
  id: 'provider-id:gpt-5.6-luna',
  object: 'model',
  created: 0,
  name: 'gpt-5.6-luna',
  owned_by: 'provider-id',
  provider: 'provider-id',
  provider_model_id: 'gpt-5.6-luna',
  ...overrides
})

const createPolicy = (
  overrides: Partial<ModelPolicy['assistant']> = {},
  rules?: Partial<ModelPolicy['rules']>
): ModelPolicy => ({
  schemaVersion: 1,
  version: 2,
  defaults: {
    chat: 'gpt-5.6-luna',
    quick: 'gpt-5.6-luna',
    translate: 'gpt-5.6-luna',
    assistant: 'gpt-5.6-luna',
    assistantNewSession: 'gpt-5.6-luna'
  },
  assistant: {
    nonDeveloperAllowlist: ['gpt-5.6-luna'],
    developerAllowlist: ['gpt-5.4-mini'],
    blockedModels: [],
    fallbackModels: ['gpt-5.4-mini'],
    ...overrides
  },
  rules: {
    applyToNewSessions: true,
    overwriteUserChoice: false,
    preserveExistingSessions: true,
    developerModeBypassAllowlist: false,
    ...rules
  }
})

describe('agent model selection policy', () => {
  it.each(STANDARD_AGENT_MODEL_IDS)('allows %s in standard mode', (modelId) => {
    expect(
      isStandardAgentModel(
        createApiModel({
          id: `provider-id:${modelId}`,
          name: modelId,
          provider_model_id: modelId
        })
      )
    ).toBe(true)
  })

  it('recognizes provider-prefixed and namespaced model identifiers', () => {
    expect(
      isStandardAgentModel(
        createApiModel({
          id: 'provider-id:google/gemini-3-flash-preview',
          name: 'Gemini 3 Flash',
          provider_model_id: 'google/gemini-3-flash-preview'
        })
      )
    ).toBe(true)
  })

  it('rejects models outside the standard selection list', () => {
    expect(
      isStandardAgentModel(
        createApiModel({
          id: 'provider-id:gpt-5.6-sol',
          name: 'gpt-5.6-sol',
          provider_model_id: 'gpt-5.6-sol'
        })
      )
    ).toBe(false)
  })

  it('does not accept partial model-name matches', () => {
    expect(
      isStandardAgentModel(
        createApiModel({
          id: 'provider-id:gpt-5.6-luna-thinking',
          name: 'gpt-5.6-luna-thinking',
          provider_model_id: 'gpt-5.6-luna-thinking'
        })
      )
    ).toBe(false)
  })

  it('resolves the provider-qualified ID for the requested model', () => {
    const models = [
      createApiModel({
        id: 'provider-id:google/gemini-3-flash-preview',
        name: 'Gemini 3 Flash',
        provider_model_id: 'google/gemini-3-flash-preview'
      }),
      createApiModel()
    ]

    expect(findAgentModelId(models, 'gpt-5.6-luna')).toBe('provider-id:gpt-5.6-luna')
  })

  it('keeps Provider affinity and otherwise prefers the official Provider', () => {
    const local = createApiModel({
      id: 'local:gpt-5.6-luna',
      provider: 'local',
      owned_by: 'local'
    })
    const official = createApiModel({
      id: 'zen-official:gpt-5.6-luna',
      provider: 'zen-official',
      owned_by: 'zen-official',
      is_official_provider: true
    })

    expect(findAgentModelId([local, official], 'gpt-5.6-luna', 'local')).toBe('local:gpt-5.6-luna')
    expect(findAgentModelId([local, official], 'gpt-5.6-luna')).toBe('zen-official:gpt-5.6-luna')
    expect(findAgentModelId([local, official], 'local:gpt-5.6-luna')).toBe('local:gpt-5.6-luna')
  })

  it('recognizes current and stale provider-prefixed model identifiers', () => {
    expect(normalizeAgentModelIdentifier('provider-id:openai/gpt-5.4-mini')).toBe('gpt-5.4-mini')
    expect(isStandardAgentModelIdentifier('provider-id:openai/gpt-5.4-mini')).toBe(false)
    expect(isStandardAgentModelIdentifier('provider-id:claude-opus-4-6')).toBe(false)
    expect(isStandardAgentModelIdentifier('provider-id:gpt-5.6-luna')).toBe(true)
    expect(isStandardAgentModelIdentifier('provider-id:grok-4.5')).toBe(true)
  })

  it('uses the remote allowlists and gives blocked models priority', () => {
    const policy = createPolicy({ blockedModels: ['provider-id:gpt-5.4-mini'] })
    const allowedForUser = createApiModel({
      id: 'provider-id:gpt-5.6-luna',
      name: 'gpt-5.6-luna',
      provider_model_id: 'gpt-5.6-luna'
    })
    const blockedForDeveloper = createApiModel({
      id: 'provider-id:gpt-5.4-mini',
      name: 'gpt-5.4-mini',
      provider_model_id: 'gpt-5.4-mini'
    })

    expect(isAssistantModelAllowed(allowedForUser, false, policy)).toBe(true)
    expect(isAssistantModelAllowed(blockedForDeveloper, true, policy)).toBe(false)
    expect(isAssistantModelBlocked(blockedForDeveloper, policy)).toBe(true)
    expect(isAssistantModelIdentifierBlocked('provider-id:gpt-5.4-mini', policy)).toBe(true)
    expect(isAssistantModelIdentifierAllowed('provider-id:gpt-5.4-mini', true, policy)).toBe(false)
  })

  it('does not treat an empty developer allowlist as an implicit bypass when disabled', () => {
    const policy = createPolicy({ developerAllowlist: [] }, { developerModeBypassAllowlist: false })
    const unrestrictedModel = createApiModel({
      id: 'provider-id:claude-opus-4-6',
      name: 'claude-opus-4-6',
      provider_model_id: 'claude-opus-4-6'
    })

    expect(isAssistantModelAllowed(unrestrictedModel, true, policy)).toBe(false)
  })
})
