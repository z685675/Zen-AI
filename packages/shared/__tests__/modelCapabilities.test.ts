import { describe, expect, it } from 'vitest'

import { parseAvailableModels } from '../config/modelAvailability'
import {
  getModelCapabilities,
  intersectModelCapabilities,
  parseModelCapabilities,
  registerModelCapabilities,
  setProviderModelCapabilities
} from '../modelCapabilities'
import { resolveModelTokenLimits } from '../utils/modelTokenLimits'

describe('centrally supplied model capabilities', () => {
  it('accepts a future exact ID without a client release and refreshes an already-selected object', () => {
    const selected = {
      provider: 'future-test',
      id: 'new-model',
      contextWindowTokens: 200_000,
      contextCapacitySource: 'provider'
    }
    const models = parseAvailableModels({
      success: true,
      object: 'list',
      data: [
        {
          id: 'new-model',
          model_capabilities: {
            context_length: 1_000_000,
            max_input_tokens: 800_000,
            max_output_tokens: 64_000,
            tools: false,
            input_modalities: ['text']
          }
        }
      ]
    })
    setProviderModelCapabilities(selected.provider, models)
    expect(resolveModelTokenLimits(selected)).toEqual({ context: 1_000_000, input: 800_000, output: 64_000 })
    expect(getModelCapabilities(selected)?.tools).toBe(false)
    registerModelCapabilities(selected.provider, selected.id, { context_length: 500_000, max_output_tokens: 32_000 })
    expect(resolveModelTokenLimits(selected).context).toBe(500_000)
    expect(getModelCapabilities({ ...selected, provider: 'another-account' })).toBeUndefined()
  })

  it('preserves manual capacity and clears removed metadata', () => {
    const selected = {
      provider: 'manual-test',
      id: 'alias',
      contextWindowTokens: 80_000,
      maxOutputTokens: 4_000,
      contextCapacitySource: 'user'
    }
    registerModelCapabilities(selected.provider, selected.id, {
      context_length: 900_000,
      max_input_tokens: 800_000,
      max_output_tokens: 64_000
    })
    expect(resolveModelTokenLimits(selected)).toEqual({ context: 80_000, output: 4_000 })
    expect(resolveModelTokenLimits({ ...selected, contextCapacitySource: 'adaptive' }).context).toBe(80_000)
    setProviderModelCapabilities(selected.provider, [])
    expect(getModelCapabilities(selected)).toBeUndefined()
  })

  it('keeps false, empty and unknown distinct and rejects malformed metadata without hiding the model', () => {
    expect(parseModelCapabilities({ tools: false, input_modalities: [], reasoning: null })).toEqual({
      tools: false,
      input_modalities: []
    })
    expect(parseModelCapabilities({ tools: 'false', context_length: -1 })).toBeUndefined()
    expect(
      parseAvailableModels({ success: true, object: 'list', data: [{ id: 'ok', model_capabilities: 'bad' }] })[0].id
    ).toBe('ok')
    expect(
      intersectModelCapabilities([
        { tools: true, context_length: 900_000, input_modalities: ['text', 'image'] },
        { tools: false, context_length: 64_000, input_modalities: ['text'] }
      ])
    ).toMatchObject({ tools: false, context_length: 64_000, input_modalities: ['text'] })
    expect(intersectModelCapabilities([{ tools: true }, {}])?.tools).toBeUndefined()
    expect(intersectModelCapabilities([{ tools: false }, undefined])?.tools).toBe(false)
  })
})
