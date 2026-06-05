import { createMigrate } from 'redux-persist'
import { describe, expect, it } from 'vitest'

describe('default model migration', () => {
  describe('migration 215: one-time default model reset', () => {
    const normalizeDefaultModelId = (value: string | undefined) =>
      (value ?? '')
        .trim()
        .toLowerCase()
        .replace(/^openai\//, '')

    const findEnabledDefaultModel = (state: any, targetModelId: string) => {
      const normalizedTarget = normalizeDefaultModelId(targetModelId)

      return state.llm.providers
        .filter((provider: any) => provider.enabled)
        .flatMap((provider: any) => provider.models)
        .find((model: any) => normalizeDefaultModelId(model.id) === normalizedTarget)
    }

    const migrate215 = (state: any) => {
      const assistantModel = findEnabledDefaultModel(state, 'gpt-5.4')
      const utilityModel = findEnabledDefaultModel(state, 'gpt-5.4-mini')

      state.llm.defaultModel = assistantModel
      state.llm.quickModel = utilityModel
      state.llm.translateModel = utilityModel
      return state
    }

    const migrate = createMigrate({ '215': migrate215 as any })

    it('sets assistant, quick, and translate defaults to the required enabled models', async () => {
      const state = {
        llm: {
          defaultModel: { id: 'old-default', provider: 'old', name: 'Old Default', group: 'Old' },
          quickModel: { id: 'old-quick', provider: 'old', name: 'Old Quick', group: 'Old' },
          translateModel: { id: 'old-translate', provider: 'old', name: 'Old Translate', group: 'Old' },
          providers: [
            {
              id: 'new-api',
              enabled: true,
              models: [
                { id: 'openai/gpt-5.4', provider: 'new-api', name: 'GPT 5.4', group: 'OpenAI' },
                { id: 'gpt-5.4-mini', provider: 'new-api', name: 'GPT 5.4 mini', group: 'OpenAI' }
              ]
            }
          ]
        },
        _persist: { version: 214, rehydrated: false }
      }

      const migrated: any = await migrate(state, 215)

      expect(migrated.llm.defaultModel).toEqual({
        id: 'openai/gpt-5.4',
        provider: 'new-api',
        name: 'GPT 5.4',
        group: 'OpenAI'
      })
      expect(migrated.llm.quickModel).toEqual({
        id: 'gpt-5.4-mini',
        provider: 'new-api',
        name: 'GPT 5.4 mini',
        group: 'OpenAI'
      })
      expect(migrated.llm.translateModel).toEqual(migrated.llm.quickModel)
    })

    it('clears defaults when the required models are not available on enabled providers', async () => {
      const state = {
        llm: {
          defaultModel: { id: 'old-default', provider: 'old', name: 'Old Default', group: 'Old' },
          quickModel: { id: 'old-quick', provider: 'old', name: 'Old Quick', group: 'Old' },
          translateModel: { id: 'old-translate', provider: 'old', name: 'Old Translate', group: 'Old' },
          providers: [
            {
              id: 'disabled-provider',
              enabled: false,
              models: [
                { id: 'gpt-5.4', provider: 'disabled-provider', name: 'GPT 5.4', group: 'OpenAI' },
                { id: 'gpt-5.4-mini', provider: 'disabled-provider', name: 'GPT 5.4 mini', group: 'OpenAI' }
              ]
            },
            {
              id: 'enabled-provider',
              enabled: true,
              models: [{ id: 'other-model', provider: 'enabled-provider', name: 'Other', group: 'Other' }]
            }
          ]
        },
        _persist: { version: 214, rehydrated: false }
      }

      const migrated: any = await migrate(state, 215)

      expect(migrated.llm.defaultModel).toBeUndefined()
      expect(migrated.llm.quickModel).toBeUndefined()
      expect(migrated.llm.translateModel).toBeUndefined()
    })
  })
})
