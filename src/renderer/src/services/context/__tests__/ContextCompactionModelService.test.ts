import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  beginContextCompactionModelProbe,
  getContextCompactionModelProbeToken,
  isContextCompactionModelCoolingDown,
  isContextCompactionModelProbeDue,
  recordContextCompactionModelFailure,
  recordContextCompactionModelProbeFailure,
  recordContextCompactionModelSuccess,
  resetContextCompactionModelHealth,
  resetContextCompactionModelHealthForProvider
} from '../ContextCompactionModelHealthService'
import {
  CONTEXT_COMPACTION_REQUEST_HEADERS,
  createContextCompactionGenerator,
  isContextCompactionModelFailureFreezable,
  isContextCompactionTextModel,
  resolveContextCompactionModels
} from '../ContextCompactionModelService'

const createProvider = (
  id: string,
  modelIds: string[],
  enabled = true,
  apiHost = 'https://zenai.925636.xyz/v1'
): Provider => ({
  id,
  type: 'new-api',
  name: id,
  apiKey: 'test-key',
  apiHost,
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

  it('uses the local checkpoint when the API panel setting is absent', () => {
    expect(resolveContextCompactionModels({ providers: [provider], currentModel })).toEqual([])
  })

  it('uses the local checkpoint when the API panel explicitly clears the model list', () => {
    expect(resolveContextCompactionModels({ providers: [provider], configuredModelIds: [], currentModel })).toEqual([])
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

  it('excludes embedding and dedicated image-generation models from checkpoint candidates', () => {
    const mixedProvider = createProvider('provider-mixed', ['text-embedding-3-small', 'gpt-image2.5', 'gpt-5.6-sol'])
    expect(
      resolveContextCompactionModels({
        providers: [mixedProvider],
        configuredModelIds: ['text-embedding-3-small', 'gpt-image2.5', 'gpt-5.6-sol']
      }).map((model) => model.id)
    ).toEqual(['gpt-5.6-sol'])
    expect(isContextCompactionTextModel(mixedProvider.models[0])).toBe(false)
    expect(isContextCompactionTextModel(mixedProvider.models[1])).toBe(false)
    expect(isContextCompactionTextModel(mixedProvider.models[2])).toBe(true)
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

  it('never uses a non-Zen provider for checkpoint generation', () => {
    const localProvider = createProvider('local', ['model-1'], true, 'http://127.0.0.1:8080/v1')
    expect(
      resolveContextCompactionModels({
        providers: [localProvider],
        configuredModelIds: ['model-1'],
        currentModel: localProvider.models[0]
      })
    ).toEqual([])
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

  it('does not let an API-panel health snapshot override local model testing', () => {
    expect(
      resolveContextCompactionModels({
        providers: [provider],
        configuredModelIds: ['model-1', 'model-2', 'model-3'],
        currentModel
      }).map((model) => model.id)
    ).toEqual(['model-1', 'model-2', 'model-3'])
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

  it('does not mark a model healthy until the complete checkpoint is accepted', async () => {
    const failureNow = Date.now()
    recordContextCompactionModelFailure(currentModel, failureNow)
    const generate = createContextCompactionGenerator({
      models: [currentModel],
      generate: async () => 'non-empty but not yet validated'
    })

    await expect(generate('prompt', 'content')).resolves.toBe('non-empty but not yet validated')
    expect(isContextCompactionModelCoolingDown(currentModel, failureNow + 1)).toBe(true)

    generate.markLastModelSuccess?.()
    expect(isContextCompactionModelCoolingDown(currentModel, failureNow + 1)).toBe(false)
  })

  it('clears a frozen model when its Provider configuration changes', () => {
    recordContextCompactionModelFailure(currentModel, Date.now())
    expect(isContextCompactionModelCoolingDown(currentModel)).toBe(true)

    resetContextCompactionModelHealthForProvider(currentModel.provider, [currentModel])

    expect(isContextCompactionModelCoolingDown(currentModel)).toBe(false)
  })

  it('treats a recovery probe as frozen until it completes', () => {
    const failureNow = Date.now()
    const failure = recordContextCompactionModelFailure(currentModel, failureNow)
    expect(beginContextCompactionModelProbe(currentModel, failure.unavailableUntil)).toBe(true)
    expect(
      resolveContextCompactionModels({
        providers: [provider],
        configuredModelIds: ['model-1'],
        currentModel
      })
    ).toEqual([])
  })

  it('does not let a stale probe failure re-freeze a model after recovery', () => {
    const failure = recordContextCompactionModelFailure(currentModel, 1_000)
    expect(beginContextCompactionModelProbe(currentModel, failure.unavailableUntil)).toBe(true)
    const probeToken = getContextCompactionModelProbeToken(currentModel)
    expect(probeToken).toBeDefined()

    recordContextCompactionModelSuccess(currentModel)
    expect(recordContextCompactionModelProbeFailure(currentModel, probeToken!, 302_000)).toBeUndefined()
    expect(isContextCompactionModelCoolingDown(currentModel, 302_000)).toBe(false)
  })

  it('uses a fixed five-minute recovery window', () => {
    const firstFailure = recordContextCompactionModelFailure(currentModel, 1_000)
    expect(firstFailure.unavailableUntil).toBe(301_000)
    expect(isContextCompactionModelProbeDue(currentModel, 300_999)).toBe(false)
    expect(isContextCompactionModelProbeDue(currentModel, 301_000)).toBe(true)

    const secondFailure = recordContextCompactionModelFailure(currentModel, 301_000)
    expect(secondFailure.unavailableUntil).toBe(601_000)
  })

  it('deduplicates background probes and respects the local cooldown', () => {
    const failure = recordContextCompactionModelFailure(currentModel, 1_000)
    expect(beginContextCompactionModelProbe(currentModel, failure.unavailableUntil - 1)).toBe(false)
    expect(beginContextCompactionModelProbe(currentModel, failure.unavailableUntil)).toBe(true)
    expect(beginContextCompactionModelProbe(currentModel, failure.unavailableUntil)).toBe(false)

    recordContextCompactionModelSuccess(currentModel)
    recordContextCompactionModelFailure(currentModel)
    expect(beginContextCompactionModelProbe(currentModel)).toBe(false)
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

  it('moves to the next model immediately when a non-empty checkpoint is invalid', async () => {
    const calls: string[] = []
    const generate = createContextCompactionGenerator({
      models: provider.models,
      generate: async (model) => {
        calls.push(model.id)
        return model.id === 'model-1' ? 'incomplete checkpoint' : 'valid checkpoint'
      },
      validateOutput: (output) => output === 'valid checkpoint'
    })

    await expect(generate('prompt', 'content')).resolves.toBe('valid checkpoint')
    expect(calls).toEqual(['model-1', 'model-2'])
    expect(isContextCompactionModelCoolingDown(provider.models[0])).toBe(true)
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

  it('does not freeze a model for a confirmed local network failure', () => {
    expect(isContextCompactionModelFailureFreezable({ code: 'ERR_INTERNET_DISCONNECTED' })).toBe(false)
    expect(isContextCompactionModelFailureFreezable(new DOMException('cancelled', 'AbortError'))).toBe(false)
    expect(isContextCompactionModelFailureFreezable(new Error('Failed to fetch'))).toBe(false)
    expect(
      isContextCompactionModelFailureFreezable({
        name: 'TypeError',
        message: 'Network request failed',
        cause: { code: 'ENOTFOUND', message: 'DNS lookup failed' }
      })
    ).toBe(false)
    expect(isContextCompactionModelFailureFreezable({ status: 503, message: 'Failed to fetch' })).toBe(true)
    expect(isContextCompactionModelFailureFreezable({ status: 0, message: 'Failed to fetch' })).toBe(false)
    expect(isContextCompactionModelFailureFreezable(new Error('provider returned 503'))).toBe(true)
    expect(isContextCompactionModelFailureFreezable(new DOMException('The operation timed out', 'TimeoutError'))).toBe(
      true
    )
    expect(isContextCompactionModelFailureFreezable(new Error('request timed out'))).toBe(true)
  })
})
