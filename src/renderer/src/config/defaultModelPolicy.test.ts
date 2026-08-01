import type { Model, Provider } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import {
  CURRENT_DEFAULT_MODEL_POLICY_VERSION,
  getCurrentDefaultModels,
  getPendingCurrentDefaultModels
} from './defaultModelPolicy'

function createModels(modelIds: string[]): Model[] {
  return modelIds.map((id) => ({
    id,
    provider: 'new-api',
    name: id,
    group: 'OpenAI'
  }))
}

function createProvider(models: Model[], enabled = true): Provider {
  return {
    id: 'new-api',
    name: 'New API',
    type: 'openai',
    apiKey: 'test-key',
    apiHost: 'https://example.com/v1',
    models,
    enabled
  }
}

describe('current default model policy', () => {
  it.each(['gpt-5.6-luna', 'openai/gpt-5.6-luna'])(
    'uses %s for assistant, quick, and translate defaults',
    (modelId) => {
      const defaults = getCurrentDefaultModels(createModels(['gpt-5.4', modelId, 'gpt-5.4-mini']))

      expect(defaults.defaultModel?.id).toBe(modelId)
      expect(defaults.quickModel).toBe(defaults.defaultModel)
      expect(defaults.translateModel).toBe(defaults.defaultModel)
    }
  )

  it('does not substitute another model when gpt-5.6-luna is unavailable', () => {
    const defaults = getCurrentDefaultModels(createModels(['gpt-5.4', 'gpt-5.4-mini']))

    expect(defaults).toEqual({
      defaultModel: undefined,
      quickModel: undefined,
      translateModel: undefined
    })
  })

  it('keeps the upgrade pending until luna appears on an enabled provider', () => {
    const legacyProvider = createProvider(createModels(['gpt-5.4', 'gpt-5.4-mini']))
    const syncedProvider = createProvider(createModels(['gpt-5.4', 'gpt-5.6-luna', 'gpt-5.4-mini']))

    expect(getPendingCurrentDefaultModels([legacyProvider])).toBeUndefined()
    expect(getPendingCurrentDefaultModels([syncedProvider])?.defaultModel?.id).toBe('gpt-5.6-luna')
  })

  it('does not reapply the upgrade after the one-time policy is complete', () => {
    const provider = createProvider(createModels(['gpt-5.6-luna']))

    expect(getPendingCurrentDefaultModels([provider], CURRENT_DEFAULT_MODEL_POLICY_VERSION)).toBeUndefined()
  })

  it('does not use luna from a disabled provider', () => {
    const provider = createProvider(createModels(['gpt-5.6-luna']), false)

    expect(getPendingCurrentDefaultModels([provider])).toBeUndefined()
  })
})
