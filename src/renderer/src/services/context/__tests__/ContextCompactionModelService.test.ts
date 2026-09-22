import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  isContextCompactionModelCoolingDown,
  recordContextCompactionModelFailure,
  recordContextCompactionModelSuccess,
  resetContextCompactionModelHealth
} from '../ContextCompactionModelHealthService'
import {
  CONTEXT_COMPACTION_REQUEST_HEADERS,
  createContextCompactionGenerator,
  resolveContextCompactionModels
} from '../ContextCompactionModelService'

const createProvider = (id: string, modelIds: string[], enabled = true): Provider => ({
  id,
  type: 'new-api',
  name: id,
  apiKey: 'test-key',
  apiHost: `https://${id}.example.com`,
  enabled,
  models: modelIds.map((modelId): Model => ({ id: modelId, provider: id, name: modelId, group: 'default' }))
})

describe('resolveContextCompactionModels', () => {
  const provider = createProvider('provider-a', ['model-1', 'model-2', 'model-3'])
  const currentModel = provider.models[0]

  beforeEach(() => {
    resetContextCompactionModelHealth()
  })

  it('marks auxiliary checkpoint requests as default-group-only', () => {
    expect(CONTEXT_COMPACTION_REQUEST_HEADERS).toEqual({
      'X-Zen-Context-Compaction': 'default-only'
    })
  })

  it('keeps the legacy current-model behavior when remote config is absent', () => {
    expect(resolveContextCompactionModels({ providers: [provider], currentModel })).toEqual([currentModel])
  })

  it('resolves at most three configured models in order', () => {
    expect(
      resolveContextCompactionModels({
        providers: [provider],
        configuredModelIds: ['model-2', 'model-3', 'model-1', 'ignored'],
        currentModel
      }).map((model) => model.id)
    ).toEqual(['model-2', 'model-3', 'model-1'])
  })

  it('prefers an independent provider for checkpoint generation when available', () => {
    const independentProvider = createProvider('provider-b', ['model-2'])
    expect(
      resolveContextCompactionModels({
        providers: [provider, independentProvider],
        configuredModelIds: ['model-2'],
        currentModel: provider.models[1]
      }).map((model) => model.provider)
    ).toEqual(['provider-b'])
  })

  it('does not silently fall back to the current model when an explicit list is unavailable', () => {
    expect(
      resolveContextCompactionModels({
        providers: [provider],
        configuredModelIds: ['missing-model'],
        currentModel
      })
    ).toEqual([])
  })

  it('skips models marked unavailable by the API panel', () => {
    expect(
      resolveContextCompactionModels({
        providers: [provider],
        configuredModelIds: ['model-1', 'model-2', 'model-3'],
        health: {
          'model-1': { status: 'unavailable', checkedAt: '2026-09-22T00:00:00Z' },
          'model-2': { status: 'healthy', checkedAt: '2026-09-22T00:00:00Z' }
        },
        currentModel
      }).map((model) => model.id)
    ).toEqual(['model-2', 'model-3'])
  })

  it('temporarily skips a locally failed model and restores it after success', () => {
    const failureNow = Date.now()
    recordContextCompactionModelFailure(currentModel, failureNow)
    expect(isContextCompactionModelCoolingDown(currentModel, failureNow + 1)).toBe(true)
    expect(
      resolveContextCompactionModels({
        providers: [provider],
        configuredModelIds: ['model-1'],
        currentModel
      })
    ).toEqual([])

    recordContextCompactionModelSuccess(currentModel)
    expect(isContextCompactionModelCoolingDown(currentModel, failureNow + 1)).toBe(false)
    expect(
      resolveContextCompactionModels({
        providers: [provider],
        configuredModelIds: ['model-1'],
        currentModel
      }).map((model) => model.id)
    ).toEqual(['model-1'])
  })

  it('skips disabled providers and duplicate resolved candidates', () => {
    const disabled = createProvider('disabled', ['model-2'], false)
    expect(
      resolveContextCompactionModels({
        providers: [disabled, provider],
        configuredModelIds: ['model-2', 'model-2'],
        currentModel
      }).map((model) => model.provider)
    ).toEqual(['provider-a'])
  })

  it('uses the first model when it succeeds', async () => {
    const calls: string[] = []
    const generate = createContextCompactionGenerator({
      models: provider.models,
      generate: async (model) => {
        calls.push(model.id)
        return 'checkpoint'
      }
    })

    await expect(generate('prompt', 'content')).resolves.toBe('checkpoint')
    expect(calls).toEqual(['model-1'])
  })

  it('moves to the next model and stays there after a failure', async () => {
    const calls: string[] = []
    const generate = createContextCompactionGenerator({
      models: provider.models,
      generate: async (model) => {
        calls.push(model.id)
        if (model.id === 'model-1') throw new Error('model 1 is unavailable')
        return 'checkpoint'
      }
    })

    await expect(generate('prompt', 'first')).resolves.toBe('checkpoint')
    await expect(generate('prompt', 'second')).resolves.toBe('checkpoint')
    expect(calls).toEqual(['model-1', 'model-2', 'model-2'])
  })

  it('throws after all models fail so the caller can use local checkpointing', async () => {
    const failedModels: string[] = []
    const generate = createContextCompactionGenerator({
      models: provider.models,
      generate: async () => '',
      onModelFailure: (model) => failedModels.push(model.id)
    })

    await expect(generate('prompt', 'content')).rejects.toThrow('All configured context checkpoint models failed')
    expect(failedModels).toEqual(['model-1', 'model-2', 'model-3'])
  })

  it('does not switch models after the user cancels the request', async () => {
    const calls: string[] = []
    const cancellation = new Error('cancelled')
    const generate = createContextCompactionGenerator({
      models: provider.models,
      generate: async (model) => {
        calls.push(model.id)
        throw cancellation
      },
      shouldTryNext: () => false
    })

    await expect(generate('prompt', 'content')).rejects.toBe(cancellation)
    expect(calls).toEqual(['model-1'])
  })
})
