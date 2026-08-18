import { getCurrentDefaultModels, getPendingCurrentDefaultModels } from '@renderer/config/defaultModelPolicy'
import { getEffectiveModelEndpointType } from '@renderer/config/models'
import { createMigrate } from 'redux-persist'
import { describe, expect, it } from 'vitest'

describe('default model migration', () => {
  it.each([215, 217, 224])('migration %s no longer forces a bundled model', async (version) => {
    const migrate = createMigrate({ [String(version)]: ((state: unknown) => state) as any })
    const defaults = {
      defaultModel: { id: 'user-chat', provider: 'custom' },
      quickModel: { id: 'user-quick', provider: 'custom' },
      translateModel: { id: 'user-translate', provider: 'custom' }
    }
    const state = {
      llm: {
        ...defaults,
        providers: [
          {
            id: 'new-api',
            enabled: true,
            models: [{ id: 'gpt-5.6-luna', provider: 'new-api' }]
          }
        ]
      },
      _persist: { version: version - 1, rehydrated: false }
    }

    const migrated: any = await migrate(state, version)

    expect(migrated.llm.defaultModel).toEqual(defaults.defaultModel)
    expect(migrated.llm.quickModel).toEqual(defaults.quickModel)
    expect(migrated.llm.translateModel).toEqual(defaults.translateModel)
    expect(getCurrentDefaultModels(state.llm.providers[0].models as any)).toEqual({})
    expect(getPendingCurrentDefaultModels(state.llm.providers as any)).toBeUndefined()
  })

  it('keeps the provider protocol backfill independent from model defaults', async () => {
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
