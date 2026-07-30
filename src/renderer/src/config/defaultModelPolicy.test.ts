import type { Model } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { getCurrentDefaultModels } from './defaultModelPolicy'

function createModels(modelIds: string[]): Model[] {
  return modelIds.map((id) => ({
    id,
    provider: 'new-api',
    name: id,
    group: 'OpenAI'
  }))
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
})
