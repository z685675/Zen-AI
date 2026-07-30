import type { Message } from '@renderer/types/newMessage'
import type { ModelMessage } from 'ai'
import { approximateTokenSize } from 'tokenx'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { manageConversationContext, manageStandaloneInput, serializeModelMessages } from '../ContextCompactionService'
import type { ContextBudget } from '../ContextWindowService'

const storage = new Map<string, unknown>()

Object.defineProperty(window, 'keyv', {
  configurable: true,
  value: {
    get: (key: string) => storage.get(key),
    set: (key: string, value: unknown) => storage.set(key, value),
    remove: (key: string) => storage.delete(key)
  }
})

const budget: ContextBudget = {
  contextWindowTokens: 20_000,
  maxOutputTokens: 8_000,
  source: 'fallback',
  confidence: 'low',
  safetyRatio: 0.9,
  fixedInputTokens: 0,
  safeInputTokens: 10_800,
  compactionTriggerTokens: 6_000,
  compactionTargetTokens: 3_500
}

const uiMessage = (id: string, role: 'user' | 'assistant'): Message =>
  ({
    id,
    role,
    blocks: []
  }) as Message

describe('ContextCompactionService', () => {
  beforeEach(() => {
    storage.clear()
  })

  it('serializes text and strips binary data', () => {
    const serialized = serializeModelMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'keep this text' },
          {
            type: 'file',
            data: 'data:application/pdf;base64,abc',
            mediaType: 'application/pdf',
            filename: 'report.pdf'
          }
        ]
      }
    ])

    expect(serialized).toContain('keep this text')
    expect(serialized).toContain('report.pdf')
    expect(serialized).not.toContain('base64,abc')
  })

  it('keeps full messages below the compaction trigger', async () => {
    const modelMessages: ModelMessage[] = [{ role: 'user', content: 'short request' }]
    const result = await manageConversationContext({
      modelMessages,
      uiMessages: [uiMessage('u1', 'user')],
      topicId: 'topic-short',
      budget,
      convert: async () => modelMessages,
      generate: vi.fn()
    })

    expect(result.action).toBe('full')
    expect(result.messages).toEqual(modelMessages)
  })

  it('creates and then reuses a stable checkpoint', async () => {
    const messagesById: Record<string, ModelMessage[]> = {
      u1: [{ role: 'user', content: 'old question '.repeat(4_000) }],
      a1: [{ role: 'assistant', content: 'old answer '.repeat(4_000) }],
      u2: [{ role: 'user', content: 'recent question' }]
    }
    const uiMessages = [uiMessage('u1', 'user'), uiMessage('a1', 'assistant'), uiMessage('u2', 'user')]
    const convert = async (messages: Message[]) => messages.flatMap((message) => messagesById[message.id] ?? [])
    const allMessages = await convert(uiMessages)
    const generate = vi.fn(async () => '## Current goals\n- Keep the exact project ID ZEN-42.')

    const first = await manageConversationContext({
      modelMessages: allMessages,
      uiMessages,
      topicId: 'topic-long',
      budget,
      convert,
      generate
    })

    expect(first.action).toBe('checkpoint-created')
    expect(first.messages[0].role).toBe('system')
    expect(generate).toHaveBeenCalled()

    generate.mockClear()
    const second = await manageConversationContext({
      modelMessages: allMessages,
      uiMessages,
      topicId: 'topic-long',
      budget,
      convert,
      generate
    })

    expect(second.action).toBe('checkpoint-reused')
    expect(generate).not.toHaveBeenCalled()
  })

  it('processes oversized standalone Agent input in chunks', async () => {
    const generate = vi.fn(async (_prompt: string, content: string) => {
      expect(approximateTokenSize(content)).toBeLessThanOrEqual(4_500)
      return '## Current goals\n- Process all submitted material.'
    })
    const result = await manageStandaloneInput({
      content: 'large input '.repeat(4_000),
      budget,
      generate
    })

    expect(result.action).toBe('oversized-input-compacted')
    expect(result.content).toContain('<oversized-input-checkpoint>')
    expect(result.usageAfterTokens).toBeLessThan(result.usageBeforeTokens)
    expect(generate).toHaveBeenCalled()
  })
})
