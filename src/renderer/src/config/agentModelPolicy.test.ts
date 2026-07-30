import type { ApiModel } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { isStandardAgentModel, STANDARD_AGENT_MODEL_IDS } from './agentModelPolicy'

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
})
