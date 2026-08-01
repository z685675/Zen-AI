import {
  CURRENT_DEFAULT_MODEL_POLICY_VERSION,
  getCurrentDefaultModels,
  getPendingCurrentDefaultModels
} from '@renderer/config/defaultModelPolicy'
import { getEffectiveModelEndpointType } from '@renderer/config/models'
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

  describe('migration 217: gpt-5.6-luna default model upgrade', () => {
    const migrate217 = (state: any) => {
      const enabledModels = state.llm.providers
        .filter((provider: any) => provider.enabled)
        .flatMap((provider: any) => provider.models)
      const currentDefaults = getCurrentDefaultModels(enabledModels)

      if (currentDefaults.defaultModel) {
        state.llm.defaultModel = currentDefaults.defaultModel
        state.llm.quickModel = currentDefaults.quickModel
        state.llm.translateModel = currentDefaults.translateModel
      }

      return state
    }

    const migrate = createMigrate({ '217': migrate217 as any })

    it('overrides all three defaults without changing historical conversations', async () => {
      const historicalTopics = [
        {
          id: 'topic-1',
          assistantId: 'default',
          name: 'Existing GPT-5.4 conversation',
          messages: [{ id: 'message-1', modelId: 'gpt-5.4' }]
        }
      ]
      const state = {
        llm: {
          defaultModel: { id: 'gpt-5.4', provider: 'new-api', name: 'GPT 5.4', group: 'OpenAI' },
          quickModel: { id: 'gpt-5.4-mini', provider: 'new-api', name: 'GPT 5.4 mini', group: 'OpenAI' },
          translateModel: { id: 'gpt-5.4-mini', provider: 'new-api', name: 'GPT 5.4 mini', group: 'OpenAI' },
          providers: [
            {
              id: 'new-api',
              enabled: true,
              models: [
                { id: 'gpt-5.4', provider: 'new-api', name: 'GPT 5.4', group: 'OpenAI' },
                { id: 'openai/gpt-5.6-luna', provider: 'new-api', name: 'GPT 5.6 Luna', group: 'OpenAI' },
                { id: 'gpt-5.4-mini', provider: 'new-api', name: 'GPT 5.4 mini', group: 'OpenAI' }
              ]
            }
          ]
        },
        assistants: {
          assistants: [{ id: 'default', topics: historicalTopics }]
        },
        _persist: { version: 216, rehydrated: false }
      }

      const migrated: any = await migrate(state, 217)

      expect(migrated.llm.defaultModel.id).toBe('openai/gpt-5.6-luna')
      expect(migrated.llm.quickModel).toBe(migrated.llm.defaultModel)
      expect(migrated.llm.translateModel).toBe(migrated.llm.defaultModel)
      expect(migrated.assistants.assistants[0].topics).toEqual(historicalTopics)
    })

    it('preserves existing defaults when luna is unavailable on enabled providers', async () => {
      const existingDefault = { id: 'gpt-5.4', provider: 'new-api', name: 'GPT 5.4', group: 'OpenAI' }
      const existingUtility = {
        id: 'gpt-5.4-mini',
        provider: 'new-api',
        name: 'GPT 5.4 mini',
        group: 'OpenAI'
      }
      const state = {
        llm: {
          defaultModel: existingDefault,
          quickModel: existingUtility,
          translateModel: existingUtility,
          providers: [
            {
              id: 'disabled-provider',
              enabled: false,
              models: [
                {
                  id: 'gpt-5.6-luna',
                  provider: 'disabled-provider',
                  name: 'GPT 5.6 Luna',
                  group: 'OpenAI'
                }
              ]
            },
            {
              id: 'new-api',
              enabled: true,
              models: [existingDefault, existingUtility]
            }
          ]
        },
        _persist: { version: 216, rehydrated: false }
      }

      const migrated: any = await migrate(state, 217)

      expect(migrated.llm.defaultModel).toEqual(existingDefault)
      expect(migrated.llm.quickModel).toEqual(existingUtility)
      expect(migrated.llm.translateModel).toEqual(existingUtility)
    })
  })

  describe('migration 218: provider protocol backfill', () => {
    const migrate218 = (state: any) => {
      state.llm.providers = state.llm.providers.map((provider: any) => ({
        ...provider,
        models: provider.models.map((model: any) => ({
          ...model,
          endpoint_type: model.endpoint_type ?? getEffectiveModelEndpointType(model, provider)
        }))
      }))
      return state
    }

    const migrate = createMigrate({ '218': migrate218 as any })

    it('uses provider protocol for existing models without overriding explicit endpoints', async () => {
      const state = {
        llm: {
          providers: [
            {
              id: 'custom-panel',
              type: 'openai',
              enabled: true,
              models: [
                { id: 'grok-4.5', provider: 'custom-panel', name: 'Grok 4.5', group: 'xAI' },
                {
                  id: 'gemini-3-flash-preview',
                  provider: 'custom-panel',
                  name: 'Gemini 3 Flash',
                  group: 'Gemini',
                  endpoint_type: 'gemini'
                }
              ]
            }
          ]
        },
        _persist: { version: 217, rehydrated: false }
      }

      const migrated: any = await migrate(state, 218)

      expect(migrated.llm.providers[0].models[0].endpoint_type).toBe('openai')
      expect(migrated.llm.providers[0].models[1].endpoint_type).toBe('gemini')
    })
  })

  describe('migration 224: durable gpt-5.6-luna upgrade', () => {
    const migrate224 = (state: any) => {
      const currentDefaults = getPendingCurrentDefaultModels(state.llm.providers, state.llm.defaultModelPolicyVersion)

      if (currentDefaults?.defaultModel) {
        state.llm.defaultModel = currentDefaults.defaultModel
        state.llm.quickModel = currentDefaults.defaultModel
        state.llm.translateModel = currentDefaults.defaultModel
        state.llm.defaultModelPolicyVersion = CURRENT_DEFAULT_MODEL_POLICY_VERSION
      }

      return state
    }

    const migrate = createMigrate({ '224': migrate224 as any })

    it('updates all defaults and records completion when luna is already available', async () => {
      const luna = { id: 'gpt-5.6-luna', provider: 'new-api', name: 'GPT 5.6 Luna', group: 'OpenAI' }
      const state = {
        llm: {
          defaultModel: { id: 'gpt-5.4', provider: 'new-api' },
          quickModel: { id: 'gpt-5.4-mini', provider: 'new-api' },
          translateModel: { id: 'gpt-5.4-mini', provider: 'new-api' },
          providers: [{ id: 'new-api', enabled: true, models: [luna] }]
        },
        _persist: { version: 223, rehydrated: false }
      }

      const migrated: any = await migrate(state, 224)

      expect(migrated.llm.defaultModel).toEqual(luna)
      expect(migrated.llm.quickModel).toEqual(luna)
      expect(migrated.llm.translateModel).toEqual(luna)
      expect(migrated.llm.defaultModelPolicyVersion).toBe(CURRENT_DEFAULT_MODEL_POLICY_VERSION)
    })

    it('preserves legacy defaults without marking completion when luna has not synced yet', async () => {
      const existingDefault = { id: 'gpt-5.4', provider: 'new-api' }
      const state = {
        llm: {
          defaultModel: existingDefault,
          quickModel: { id: 'gpt-5.4-mini', provider: 'new-api' },
          translateModel: { id: 'gpt-5.4-mini', provider: 'new-api' },
          providers: [{ id: 'new-api', enabled: true, models: [existingDefault] }]
        },
        _persist: { version: 223, rehydrated: false }
      }

      const migrated: any = await migrate(state, 224)

      expect(migrated.llm.defaultModel).toEqual(existingDefault)
      expect(migrated.llm.defaultModelPolicyVersion).toBeUndefined()
    })
  })
})
