import { describe, expect, it } from 'vitest'

import { getModelLogoById } from '../logo'

describe('getModelLogoById', () => {
  it.each(['gpt-6-luna', 'gpt-6-sol', 'openai/gpt-6-sol', 'GPT-7-preview'])(
    'uses the GPT family logo for new model ID %s',
    (modelId) => {
      expect(getModelLogoById(modelId)).toBe(getModelLogoById('gpt-oss'))
    }
  )

  it.each([
    ['gemini-9-flash', 'gemini-2.5-flash'],
    ['claude-opus-5', 'claude-3-opus'],
    ['grok-9-latest', 'grok-4']
  ])('keeps the existing vendor logo for new model ID %s', (modelId, knownModelId) => {
    expect(getModelLogoById(modelId)).toBe(getModelLogoById(knownModelId))
  })

  it('does not mistake unrelated IDs containing the letters gpt for GPT models', () => {
    expect(getModelLogoById('mygptish-model')).toBeUndefined()
  })
})
