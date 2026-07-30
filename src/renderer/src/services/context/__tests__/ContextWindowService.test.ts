import type { Model, Provider } from '@renderer/types'
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
  beforeEach(() => {
    adaptiveStorage.clear()
  })

  it('uses the 256K fallback for New API models without provider metadata', () => {
    expect(resolveModelContextProfile(model, newApiProvider)).toMatchObject({
      contextWindowTokens: 256_000,
      maxOutputTokens: 32_000,
      source: 'fallback',
      confidence: 'low'
    })
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

  it('creates an approximately 180K compaction trigger for a 256K model', () => {
    const budget = createContextBudget({ model, provider: newApiProvider })

    expect(budget.safeInputTokens).toBe(201_600)
    expect(budget.compactionTriggerTokens).toBe(181_440)
    expect(budget.compactionTargetTokens).toBe(116_927)
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
      currentContextWindowTokens: 256_000
    })
    const profile = resolveModelContextProfile(model, newApiProvider)

    expect(learnedCapacity).toBe(159_840)
    expect(profile).toMatchObject({
      contextWindowTokens: learnedCapacity,
      source: 'adaptive',
      confidence: 'medium'
    })

    clearAdaptiveContextWindowTokens(model, newApiProvider)
    expect(resolveModelContextProfile(model, newApiProvider).contextWindowTokens).toBe(256_000)
  })

  it('recognizes common upstream context-limit errors without matching normal failures', () => {
    expect(isContextCapacityError(new Error('context_length_exceeded: maximum context length reached'))).toBe(true)
    expect(isContextCapacityError({ message: '请求超过上下文长度限制' })).toBe(true)
    expect(isContextCapacityError(new Error('401 invalid API key'))).toBe(false)
  })
})
