import type { ApiModel } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import {
  findAgentModelId,
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

  it('recognizes current and stale provider-prefixed model identifiers', () => {
    expect(normalizeAgentModelIdentifier('provider-id:openai/gpt-5.4-mini')).toBe('gpt-5.4-mini')
    expect(isStandardAgentModelIdentifier('provider-id:openai/gpt-5.4-mini')).toBe(false)
    expect(isStandardAgentModelIdentifier('provider-id:claude-opus-4-6')).toBe(false)
    expect(isStandardAgentModelIdentifier('provider-id:gpt-5.6-luna')).toBe(true)
    expect(isStandardAgentModelIdentifier('provider-id:grok-4.5')).toBe(true)
  })
})
