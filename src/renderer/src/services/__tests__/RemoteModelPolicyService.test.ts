import type { Model, Provider } from '@renderer/types'
import type { ModelPolicySnapshot } from '@shared/config/modelPolicy'
import { expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: { llm: { providers: [] }, runtime: { loadingMap: {} }, messages: { loadingByTopic: {} } } as any,
  refresh: vi.fn()
}))
vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mocks.state,
    dispatch: (action: any) => {
      if (action.type === 'llm/setModelPolicy') mocks.state.llm.modelPolicy = action.payload
      if (action.type === 'llm/applyRemoteModelPolicy') {
        const { progress, version, ...fields } = action.payload
        Object.assign(mocks.state.llm, fields, { remoteModelPolicyProgress: progress })
        if (version !== undefined) mocks.state.llm.remoteModelPolicyVersion = version
      }
    }
  }
}))
vi.mock('@renderer/store/llm', () => ({
  setModelPolicy: (payload: unknown) => ({ type: 'llm/setModelPolicy', payload }),
  applyRemoteModelPolicy: (payload: unknown) => ({ type: 'llm/applyRemoteModelPolicy', payload })
}))
vi.mock('@renderer/services/EventService', () => ({ EVENT_NAMES: {}, EventEmitter: {} }))
vi.mock('@renderer/services/HealthCheckService', () => ({ checkModelWithAnyKey: vi.fn() }))
vi.mock('@renderer/services/context/ContextCompactionModelService', () => ({
  CONTEXT_COMPACTION_REQUEST_HEADERS: {},
  isContextCompactionModelFailureFreezable: vi.fn(),
  isContextCompactionTextModel: vi.fn()
}))
vi.mock('../ProviderModelSyncUtils', () => ({ getProviderContextHealthFingerprint: vi.fn() }))

import { reconcileRemoteModelPolicyDefaults, refreshRemoteModelPolicy } from '../RemoteModelPolicyService'

const model = (id: string): Model => ({ id, provider: 'zen', name: id, group: 'default' })
const snapshot = {
  source: 'remote',
  version: 17,
  policy: {
    defaults: { chat: 'new-chat', quick: 'new-quick', translate: 'new-translate' },
    rules: { overwriteUserChoice: true }
  }
} as ModelPolicySnapshot

it('applies delayed defaults once each and honors user changes made while other defaults are pending', async () => {
  const provider: Provider = {
    id: 'zen',
    name: 'Fixture',
    type: 'new-api',
    apiHost: 'https://zenai.925636.xyz/v1',
    enabled: true,
    apiKey: 'fixture',
    models: [model('old'), model('pick'), model('new-quick')]
  }
  const llm = mocks.state.llm
  Object.assign(llm, {
    providers: [provider],
    defaultModel: model('old'),
    quickModel: model('old'),
    translateModel: model('old')
  })
  mocks.refresh.mockResolvedValue(snapshot)
  window.api.modelPolicy = { ...window.api.modelPolicy, refresh: mocks.refresh }
  await refreshRemoteModelPolicy()
  expect(llm.quickModel.id).toBe('new-quick')
  expect(llm.remoteModelPolicyVersion).toBeUndefined()

  llm.quickModel = model('pick')
  llm.translateModel = model('pick')
  provider.models.push(model('new-chat'), model('new-translate'))
  reconcileRemoteModelPolicyDefaults()
  expect(llm.defaultModel.id).toBe('new-chat')
  expect(llm.quickModel.id).toBe('pick')
  expect(llm.translateModel.id).toBe('pick')
  expect(llm.remoteModelPolicyVersion).toBe(17)
})
