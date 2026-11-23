import { describe, expect, it } from 'vitest'

import { getModelLogo, getModelLogoById } from '../logo'

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
import { registerModelCapabilities } from '@shared/modelCapabilities'

describe('getModelLogo', () => {
  it('uses the synced model identity for aliases and new providers', () => {
    const model = { provider: 'logo-test', id: 'gpt-local-alias', name: 'Local alias', group: '' }
    registerModelCapabilities(model.provider, model.id, { canonical_id: 'anthropic/claude-3-opus' })
    expect(getModelLogo(model)).toBe(getModelLogoById('claude-3-opus'))

    registerModelCapabilities(model.provider, model.id, { canonical_id: 'future-provider/unknown-llm' })
    expect(getModelLogo(model)).toBe('https://models.dev/logos/future-provider.svg')

    registerModelCapabilities(model.provider, model.id, undefined)
    expect(getModelLogo(model)).toBe(getModelLogoById(model.id))
  })
})
