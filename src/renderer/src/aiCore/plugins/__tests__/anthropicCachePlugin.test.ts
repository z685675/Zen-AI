import type { LanguageModelV3Message } from '@ai-sdk/provider'
import type { AnthropicCacheControlSettings } from '@renderer/types/provider'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/services/TokenService', () => ({
  estimateTextTokens: (text: string) => text.length
}))

import { applyAnthropicPromptCaching, selectAnthropicCacheBreakpointIndices } from '../anthropicCachePlugin'

function getCachedContentPart(message: LanguageModelV3Message) {
  return Array.isArray(message.content) ? message.content[0] : undefined
}

function makeTextMessage(role: LanguageModelV3Message['role'], text: string): LanguageModelV3Message {
  return {
    role,
    content: [{ type: 'text', text }]
  } as LanguageModelV3Message
}

function makeSettings(overrides: Partial<AnthropicCacheControlSettings> = {}): AnthropicCacheControlSettings {
  return {
    tokenThreshold: 100,
    cacheSystemMessage: true,
    cacheLastNMessages: 0,
    ...overrides
  }
}

describe('anthropicCachePlugin', () => {
  it('caches conversation messages even when recent-message caching is disabled', () => {
    const prompt: LanguageModelV3Message[] = [
      { role: 'system', content: 's'.repeat(120) },
      makeTextMessage('user', 'u'.repeat(120)),
      makeTextMessage('assistant', 'a'.repeat(120))
    ]

    const cachedPrompt = applyAnthropicPromptCaching(prompt, makeSettings({ cacheLastNMessages: 0 }))

    expect(cachedPrompt[0]).toHaveProperty('providerOptions.anthropic.cacheControl.type', 'ephemeral')
    expect(getCachedContentPart(cachedPrompt[1])).toHaveProperty(
      'providerOptions.anthropic.cacheControl.type',
      'ephemeral'
    )
    expect(getCachedContentPart(cachedPrompt[2])).toHaveProperty(
      'providerOptions.anthropic.cacheControl.type',
      'ephemeral'
    )
  })

  it('reserves one stable-prefix breakpoint when recent-message caching is large', () => {
    const prompt: LanguageModelV3Message[] = [
      { role: 'system', content: 's'.repeat(120) },
      makeTextMessage('user', '1'.repeat(120)),
      makeTextMessage('assistant', '2'.repeat(120)),
      makeTextMessage('user', '3'.repeat(120)),
      makeTextMessage('assistant', '4'.repeat(120)),
      makeTextMessage('user', '5'.repeat(120))
    ]

    const indices = selectAnthropicCacheBreakpointIndices(prompt, makeSettings({ cacheLastNMessages: 10 }))

    expect(indices).toEqual([0, 3, 4, 5])
  })

  it('never exceeds Anthropic-friendly breakpoint limits', () => {
    const prompt: LanguageModelV3Message[] = [
      { role: 'system', content: 's'.repeat(120) },
      makeTextMessage('user', '1'.repeat(120)),
      makeTextMessage('assistant', '2'.repeat(120)),
      makeTextMessage('user', '3'.repeat(120)),
      makeTextMessage('assistant', '4'.repeat(120)),
      makeTextMessage('user', '5'.repeat(120)),
      makeTextMessage('assistant', '6'.repeat(120)),
      makeTextMessage('user', '7'.repeat(120))
    ]

    const indices = selectAnthropicCacheBreakpointIndices(prompt, makeSettings({ cacheLastNMessages: 10 }))

    expect(indices.length).toBeLessThanOrEqual(4)
  })
})
