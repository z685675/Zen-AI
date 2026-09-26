import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createContextCompactionKeyFailover } from '../ContextCompactionKeyFailover'
import { resetContextCompactionModelHealth } from '../ContextCompactionModelHealthService'
import { createContextCompactionGenerator } from '../ContextCompactionModelService'

const storage = new Map<string, unknown>()
Object.defineProperty(window, 'keyv', {
  configurable: true,
  value: {
    get: (key: string) => storage.get(key),
    set: (key: string, value: unknown) => storage.set(key, value),
    remove: (key: string) => storage.delete(key)
  }
})

const createProvider = (id: string, apiKey: string): Provider => ({
  id,
  name: id,
  type: 'new-api',
  apiKey,
  apiHost: 'https://zenai.925636.xyz/v1',
  enabled: true,
  models: []
})

const createModel = (provider: Provider, id: string): Model => ({
  id,
  name: id,
  provider: provider.id,
  group: 'default'
})

const topicId = 'context-key-failover-topic'
const keyScope = (provider: Provider, model: Model) =>
  `provider:${provider.id}:context_compaction_key:${topicId}:${model.id}`

describe('ContextCompactionKeyFailover', () => {
  beforeEach(() => {
    storage.clear()
    resetContextCompactionModelHealth()
    vi.clearAllMocks()
  })

  it('keeps one API key fixed across chunks within the same checkpoint operation', async () => {
    const provider = createProvider('provider-a', 'key-a,key-b')
    const model = createModel(provider, 'summary-model')
    storage.set(keyScope(provider, model), 'key-a')
    const calls: string[] = []
    const failover = createContextCompactionKeyFailover({
      topicId,
      resolveProvider: () => provider,
      generate: async ({ apiKey }) => {
        calls.push(apiKey ?? '')
        return 'summary'
      }
    })

    await expect(failover({ model, prompt: 'summarize', content: 'first chunk' })).resolves.toBe('summary')
    await expect(failover({ model, prompt: 'summarize', content: 'second chunk' })).resolves.toBe('summary')

    expect(calls).toEqual(['key-a', 'key-a'])
  })

  it('rotates after a key-scoped failure and keeps the replacement key for later chunks', async () => {
    const provider = createProvider('provider-a', 'key-a,key-b')
    const model = createModel(provider, 'summary-model')
    storage.set(keyScope(provider, model), 'key-a')
    const calls: string[] = []
    const failover = createContextCompactionKeyFailover({
      topicId,
      resolveProvider: () => provider,
      generate: async ({ apiKey }) => {
        calls.push(apiKey ?? '')
        if (apiKey === 'key-a') throw { status: 401, message: 'invalid API key' }
        return 'summary'
      }
    })

    await expect(failover({ model, prompt: 'summarize', content: 'first chunk' })).resolves.toBe('summary')
    await expect(failover({ model, prompt: 'summarize', content: 'second chunk' })).resolves.toBe('summary')

    expect(calls).toEqual(['key-a', 'key-b', 'key-b'])
    expect(storage.get(keyScope(provider, model))).toBe('key-b')
  })

  it('tries every key before advancing to the next configured model', async () => {
    const firstProvider = createProvider('provider-a', 'key-a,key-b')
    const secondProvider = createProvider('provider-b', 'key-c')
    const firstModel = createModel(firstProvider, 'summary-model-a')
    const secondModel = createModel(secondProvider, 'summary-model-b')
    storage.set(keyScope(firstProvider, firstModel), 'key-a')
    storage.set(keyScope(secondProvider, secondModel), 'key-c')
    const providers = new Map([
      [firstModel.id, firstProvider],
      [secondModel.id, secondProvider]
    ])
    const calls: string[] = []
    const fetchWithKeyFailover = createContextCompactionKeyFailover({
      topicId,
      resolveProvider: (model) => providers.get(model.id)!,
      generate: async ({ model, apiKey }) => {
        calls.push(`${model.id}:${apiKey}`)
        if (model.id === firstModel.id) throw { status: 401, message: 'invalid API key' }
        return 'valid checkpoint'
      }
    })
    const generateCheckpoint = createContextCompactionGenerator({
      models: [firstModel, secondModel],
      generate: (model, prompt, content) => fetchWithKeyFailover({ model, prompt, content })
    })

    await expect(generateCheckpoint('summarize', 'conversation')).resolves.toBe('valid checkpoint')

    expect(calls).toEqual(['summary-model-a:key-a', 'summary-model-a:key-b', 'summary-model-b:key-c'])
  })
})
