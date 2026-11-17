import type { Model, Provider } from '@renderer/types'
import { registerModelCapabilities, setProviderModelCapabilities } from '@shared/modelCapabilities'
import { getModelCatalogCapacity } from '@shared/modelCapacity'
import type { ModelMessage } from 'ai'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearAdaptiveContextWindowTokens,
  createContextBudget,
  estimateModelMessagesTokens,
  isContextCapacityError,
  planContextWindow,
  recordAdaptiveContextFailure,
  resolveModelContextProfile
} from '../ContextWindowService'

const model: Model = {
  id: 'test-model',
  name: 'test-model',
  provider: 'new-api',
  group: 'test'
}

const newApiProvider = {
  id: 'new-api',
  type: 'new-api'
} as Provider

const adaptiveStorage = new Map<string, unknown>()
Object.defineProperty(window, 'keyv', {
  configurable: true,
  value: {
    get: (key: string) => adaptiveStorage.get(key),
    set: (key: string, value: unknown) => adaptiveStorage.set(key, value),
    remove: (key: string) => adaptiveStorage.delete(key)
  }
})

describe('ContextWindowService', () => {
  it('uses fresh central metadata for an already selected alias and reports its source correctly', () => {
    const selected = { ...model, provider: 'capacity-source-test', id: 'renamed-model' }
    registerModelCapabilities(selected.provider, selected.id, {
      context_length: 900_000,
      max_input_tokens: 800_000,
      max_output_tokens: 64_000,
      source: 'override'
    })
    try {
      expect(resolveModelContextProfile(selected)).toMatchObject({
        contextWindowTokens: 900_000,
        maxInputTokens: 800_000,
        source: 'provider',
        confidence: 'high'
      })
      registerModelCapabilities(selected.provider, selected.id, { context_length: 500_000, source: 'catalog' })
      expect(resolveModelContextProfile(selected)).toMatchObject({
        contextWindowTokens: 500_000,
        source: 'builtin',
        confidence: 'medium'
      })
    } finally {
      setProviderModelCapabilities(selected.provider, [])
    }
  })
  beforeEach(() => {
    adaptiveStorage.clear()
  })

  it('uses the 200K fallback for New API models without provider metadata', () => {
    expect(resolveModelContextProfile(model, newApiProvider)).toMatchObject({
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
      source: 'fallback',
      confidence: 'low'
    })
  })

  it('uses catalog context and separate input limits for known models without provider metadata', () => {
    const selected = { ...model, id: 'gpt-6.1-sol' }
    const capacity = getModelCatalogCapacity(selected.id)!
    expect(resolveModelContextProfile(selected, newApiProvider)).toMatchObject({
      contextWindowTokens: capacity.context,
      maxInputTokens: capacity.input,
      maxOutputTokens: capacity.output,
      source: 'builtin'
    })
    const budget = createContextBudget({ model: selected, provider: newApiProvider, requestedOutputTokens: 1000 })
    expect(budget.safeInputTokens).toBeLessThanOrEqual(capacity.input)
    expect(budget.safeInputTokens).toBeLessThan(capacity.context - 1000)
  })

  it('prefers provider-reported capacities and preserves output space', () => {
    const profile = resolveModelContextProfile(
      {
        ...model,
        contextWindowTokens: 400_000,
        maxOutputTokens: 16_000,
        contextCapacitySource: 'provider',
        contextCapacityConfidence: 'high'
      },
      newApiProvider
    )

    expect(profile).toEqual({
      contextWindowTokens: 400_000,
      maxOutputTokens: 16_000,
      source: 'provider',
      confidence: 'high'
    })
  })

  it('keeps million-token model capacities and large output limits instead of applying product ceilings', () => {
    const budget = createContextBudget({
      model: { ...model, contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
      requestedOutputTokens: 64_000,
      fixedInputTokens: 3_000
    })
    expect(budget.contextWindowTokens).toBe(1_000_000)
    expect(budget.maxOutputTokens).toBe(64_000)
    expect(budget.safeInputTokens).toBe(839_400)
    expect(
      resolveModelContextProfile({ ...model, contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 })
    ).toMatchObject({ maxOutputTokens: 128_000 })
  })

  it('does not replace a reported small output limit with an 8K minimum', () => {
    expect(resolveModelContextProfile({ ...model, contextWindowTokens: 32_000, maxOutputTokens: 2_048 })).toMatchObject(
      { maxOutputTokens: 2_048 }
    )
    expect(createContextBudget({ model, requestedOutputTokens: 4_096 }).maxOutputTokens).toBe(4_096)
  })

  it('keeps input space when a unified-window model advertises output equal to context', () => {
    const unified = { ...model, contextWindowTokens: 500_000, maxOutputTokens: 500_000 }
    const budget = createContextBudget({ model: unified })
    expect(budget.maxOutputTokens).toBe(32_000)
    expect(budget.safeInputTokens).toBeGreaterThan(400_000)
    expect(
      createContextBudget({
        model: { ...model, contextWindowTokens: 64_000, maxOutputTokens: 2_000 },
        requestedOutputTokens: 8_000
      }).maxOutputTokens
    ).toBe(2_000)
  })

  it('keeps a large request intact when it fits the selected model rather than a 200K product ceiling', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'verified project record '.repeat(100_000) }]
    const largeModel = { ...model, contextWindowTokens: 1_000_000, maxOutputTokens: 32_000 }
    expect(estimateModelMessagesTokens(messages).totalTokens).toBeGreaterThan(200_000)
    expect(planContextWindow(messages, createContextBudget({ model: largeModel })).action).toBe('full')
    expect(planContextWindow(messages, createContextBudget({ model })).action).toBe('compact')
  })

  it.each([NaN, Infinity, -1, 0, Number.MAX_VALUE])(
    'falls back to finite capacities for invalid metadata %s',
    (value) => {
      expect(
        resolveModelContextProfile({ ...model, contextWindowTokens: value, maxOutputTokens: value })
      ).toMatchObject({ contextWindowTokens: 200_000, maxOutputTokens: 32_000, source: 'fallback' })
    }
  )

  it('can still lower a small model budget after a real context rejection', () => {
    const smallModel = { ...model, contextWindowTokens: 16_000, maxOutputTokens: 2_000 }
    const learned = recordAdaptiveContextFailure({
      model: smallModel,
      provider: newApiProvider,
      failedInputTokens: 12_000,
      maxOutputTokens: 2_000,
      currentContextWindowTokens: 16_000
    })
    expect(learned).toBeLessThan(16_000)
    expect(resolveModelContextProfile(smallModel, newApiProvider).contextWindowTokens).toBe(learned)
  })

  it('isolates learned channel capacity from another provider using the same model alias', () => {
    const largeModel = { ...model, contextWindowTokens: 1_000_000, maxOutputTokens: 32_000 }
    recordAdaptiveContextFailure({
      model: largeModel,
      provider: newApiProvider,
      failedInputTokens: 500_000,
      maxOutputTokens: 32_000,
      currentContextWindowTokens: 1_000_000
    })
    expect(resolveModelContextProfile(largeModel, newApiProvider).contextWindowTokens).toBeLessThan(1_000_000)
    expect(resolveModelContextProfile(largeModel, { ...newApiProvider, id: 'other-route' }).contextWindowTokens).toBe(
      1_000_000
    )
  })

  it('creates an approximately 140K compaction trigger for a 200K model', () => {
    const budget = createContextBudget({ model, provider: newApiProvider })

    expect(budget.safeInputTokens).toBe(151_200)
    expect(budget.compactionTriggerTokens).toBe(136_080)
    expect(budget.compactionTargetTokens).toBe(87_696)
  })

  it('does not report an input budget larger than a small model can accept', () => {
    const budget = createContextBudget({
      model: {
        ...model,
        contextWindowTokens: 4_000,
        maxOutputTokens: 8_000
      },
      provider: newApiProvider,
      fixedInputTokens: 200
    })

    expect(budget.maxOutputTokens).toBeLessThan(8_000)
    expect(budget.safeInputTokens).toBeLessThanOrEqual(4_000 - budget.maxOutputTokens - 200)
    expect(budget.compactionTriggerTokens).toBeLessThanOrEqual(budget.safeInputTokens)
  })

  it('includes text and image parts in usage estimates', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello world' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', image: 'https://example.com/image.png' }
        ]
      }
    ]

    const usage = estimateModelMessagesTokens(messages)
    expect(usage.textTokens).toBeGreaterThan(0)
    expect(usage.imageTokens).toBe(1_700)
    expect(usage.totalTokens).toBe(usage.textTokens + usage.imageTokens)
  })

  it('keeps complete history below the trigger and plans compaction above it', () => {
    const smallBudget = createContextBudget({
      model: {
        ...model,
        contextWindowTokens: 20_000,
        maxOutputTokens: 8_000
      },
      provider: newApiProvider
    })
    const shortMessages: ModelMessage[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' }
    ]

    expect(planContextWindow(shortMessages, smallBudget).action).toBe('full')

    const longMessages: ModelMessage[] = [
      { role: 'user', content: 'old question '.repeat(2_000) },
      { role: 'assistant', content: 'old answer '.repeat(2_000) },
      { role: 'user', content: 'recent question '.repeat(2_000) }
    ]
    const plan = planContextWindow(longMessages, smallBudget)

    expect(plan.action).toBe('compact')
    expect(plan.messagesToCompact.length).toBeGreaterThan(0)
    expect(plan.recentMessages.at(-1)?.role).toBe('user')
  })

  it('plans staged processing when a request exceeds the direct image count', () => {
    const budget = createContextBudget({ model, provider: newApiProvider })
    const imageParts = Array.from({ length: 21 }, (_, index) => ({
      type: 'image' as const,
      image: `https://example.com/${index}.png`
    }))
    const plan = planContextWindow([{ role: 'user', content: imageParts }], budget)

    expect(plan.action).toBe('compact')
  })

  it('learns a lower provider capacity after a context rejection', () => {
    const learnedCapacity = recordAdaptiveContextFailure({
      model,
      provider: newApiProvider,
      failedInputTokens: 190_000,
      maxOutputTokens: 32_000,
      currentContextWindowTokens: 200_000
    })
    const profile = resolveModelContextProfile(model, newApiProvider)

    expect(learnedCapacity).toBe(144_000)
    expect(profile).toMatchObject({
      contextWindowTokens: learnedCapacity,
      source: 'adaptive',
      confidence: 'medium'
    })

    clearAdaptiveContextWindowTokens(model, newApiProvider)
    expect(resolveModelContextProfile(model, newApiProvider).contextWindowTokens).toBe(200_000)
  })

  it('recognizes common upstream context-limit errors without matching normal failures', () => {
    expect(isContextCapacityError(new Error('context_length_exceeded: maximum context length reached'))).toBe(true)
    expect(isContextCapacityError({ message: '请求超过上下文长度限制' })).toBe(true)
    expect(isContextCapacityError(new Error('401 invalid API key'))).toBe(false)
    expect(isContextCapacityError(new Error('413 Request too large'))).toBe(false)
    expect(isContextCapacityError(new Error('rate_limit_exceeded: too many tokens per minute'))).toBe(false)
    expect(isContextCapacityError(new Error('max_tokens exceeds output token limit'))).toBe(false)
  })
})
