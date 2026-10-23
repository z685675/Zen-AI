import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ state: {} as any, availability: vi.fn(), sessions: vi.fn(async () => {}) }))
vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mocks.state,
    dispatch: (action: any) => {
      if (action.type === 'llm/updateProviders') mocks.state.llm.providers = action.payload
      if (action.type === 'llm/setDefaultModel') mocks.state.llm.defaultModel = action.payload.model
      if (action.type === 'llm/setQuickModel') mocks.state.llm.quickModel = action.payload.model
      if (action.type === 'llm/setTranslateModel') mocks.state.llm.translateModel = action.payload.model
      if (action.type === 'assistants/updateAssistants') mocks.state.assistants.assistants = action.payload
      if (action.type === 'assistants/updateDefaultAssistant')
        mocks.state.assistants.defaultAssistant = action.payload.assistant
    }
  }
}))
vi.mock('../RemoteModelPolicyService', () => ({ refreshRemoteModelPolicy: vi.fn() }))

import { reconcileManagedModelReferences, syncManagedModelAvailability } from '../ModelAvailabilitySyncService'
import { modelRecoveryIntents } from '../modelRecoveryIntents'

const model = (id: string, provider = 'zen'): Model => ({ id, provider, name: id, group: 'default' })
const provider = (id = 'zen'): Provider => ({
  id,
  apiHost: id === 'zen' ? 'https://zenai.925636.xyz/v1' : 'https://other.invalid',
  apiKey: 'fake',
  type: 'new-api',
  name: id,
  enabled: true,
  models: [model('A', id), model('B', id)]
})

describe('live availability and reference repair integration', () => {
  beforeEach(() => {
    mocks.availability.mockReset()
    mocks.sessions.mockClear()
    window.api.modelPolicy = {
      ...window.api.modelPolicy,
      availability: mocks.availability,
      reconcileSessions: mocks.sessions
    }
    for (const key of [
      'global:chat',
      'global:quick',
      'global:translate',
      'assistant:one:model',
      'assistant:one:defaultModel',
      'topic:t'
    ])
      modelRecoveryIntents.set(key, undefined)
    mocks.state = {
      llm: {
        providers: [provider(), provider('third')],
        defaultModel: model('A'),
        quickModel: model('A'),
        translateModel: model('A'),
        modelPolicy: {
          policy: {
            defaults: { chat: 'A', quick: 'A', translate: 'A' },
            assistant: { fallbackModels: ['B'], blockedModels: [] }
          }
        }
      },
      runtime: { generating: false, translating: false, loadingMap: {} },
      messages: { loadingByTopic: {} },
      assistants: {
        assistants: [{ id: 'one', model: model('A'), topics: [{ id: 't', model: model('A') }] }],
        defaultAssistant: { id: 'default', topics: [] }
      }
    }
    vi.spyOn(Date, 'now').mockReturnValue(1000)
  })
  const supply = (...ids: string[]) =>
    mocks.availability.mockResolvedValue({
      providerId: 'zen',
      fetchedAt: 1000,
      fingerprint: 'test',
      models: ids.map((id) => ({ id }))
    })

  it('repairs all affected refs, accepts empty supply, preserves histories/other providers, then recovers', async () => {
    supply('B')
    const third = mocks.state.llm.providers[1]
    await syncManagedModelAvailability()
    expect(mocks.state.llm.defaultModel.id).toBe('B')
    expect(mocks.state.llm.quickModel.id).toBe('B')
    expect(mocks.state.llm.translateModel.id).toBe('B')
    expect(mocks.state.assistants.assistants[0].topics[0].model.id).toBe('B')
    expect(mocks.state.llm.providers[1]).toBe(third)
    supply()
    await syncManagedModelAvailability()
    expect(mocks.state.llm.providers[0].models).toEqual([])
    expect(mocks.state.llm.defaultModel).toBeUndefined()
    supply('A', 'B')
    await syncManagedModelAvailability()
    expect(mocks.state.llm.defaultModel.id).toBe('A') // no valid temporary model: recover immediately
  })
  it('keeps the running turn frozen, then repairs at the idle boundary', async () => {
    mocks.state.messages.loadingByTopic.t = true
    supply('B')
    await syncManagedModelAvailability()
    expect(mocks.state.llm.defaultModel.id).toBe('A')
    expect(mocks.state.assistants.assistants[0].topics[0].model.id).toBe('A')
    mocks.state.messages.loadingByTopic.t = false
    reconcileManagedModelReferences()
    expect(mocks.state.llm.defaultModel.id).toBe('B')
    expect(mocks.state.assistants.assistants[0].topics[0].model.id).toBe('B')
  })
  it('waits for a stable recovery while B remains healthy', async () => {
    supply('B')
    await syncManagedModelAvailability()
    supply('A', 'B')
    await syncManagedModelAvailability()
    expect(mocks.state.llm.defaultModel.id).toBe('B')
    vi.mocked(Date.now).mockReturnValue(301_001)
    reconcileManagedModelReferences()
    expect(mocks.state.llm.defaultModel.id).toBe('A')
  })
  it('discards a response after credentials change and does not treat transport failure as empty', async () => {
    supply('A', 'B')
    await syncManagedModelAvailability()
    mocks.availability.mockResolvedValueOnce(undefined)
    await syncManagedModelAvailability()
    expect(mocks.state.llm.defaultModel.id).toBe('A')
    mocks.availability.mockImplementationOnce(async () => {
      mocks.state.llm.providers[0] = { ...mocks.state.llm.providers[0], apiKey: 'new-key' }
      return { models: [] }
    })
    await syncManagedModelAvailability()
    expect(mocks.state.llm.providers[0].models.map((value: Model) => value.id)).toEqual(['A', 'B'])
  })
})
