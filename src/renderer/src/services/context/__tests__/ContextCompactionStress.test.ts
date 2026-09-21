import type { Message } from '@renderer/types/newMessage'
import type { ModelMessage } from 'ai'
import { approximateTokenSize } from 'tokenx'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CHECKPOINT_SECTION_HEADINGS,
  loadContextCheckpoint,
  manageConversationContext
} from '../ContextCompactionService'
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
  source: 'stress-test',
  confidence: 'high',
  safetyRatio: 0.9,
  fixedInputTokens: 0,
  safeInputTokens: 10_800,
  compactionTriggerTokens: 6_000,
  compactionTargetTokens: 3_500
}

const uiMessage = (id: string, role: 'user' | 'assistant'): Message => ({ id, role, blocks: [] }) as Message

const structuredCheckpoint = (): string =>
  CHECKPOINT_SECTION_HEADINGS.map(
    (heading) => `${heading}\n- Long conversation stress evaluation preserves ZEN-STRESS-001 and ZEN-STRESS-120.`
  ).join('\n')

describe('ContextCompactionStress evaluation', () => {
  beforeEach(() => {
    storage.clear()
  })

  it('compacts a long conversation, stays within budget, and reuses the checkpoint', async () => {
    const ids = Array.from({ length: 140 }, (_, index) => `turn-${index + 1}`)
    const uiMessages = ids.map((id, index) => uiMessage(id, index % 2 === 0 ? 'user' : 'assistant'))
    const convert = async (messages: Message[]): Promise<ModelMessage[]> =>
      messages.map((message) => ({
        role: message.role,
        content: `${message.id} ZEN-STRESS-001 ZEN-STRESS-120 long conversation evidence `.repeat(80)
      }))
    const modelMessages = await convert(uiMessages)
    const generate = vi.fn(async () => structuredCheckpoint())

    const first = await manageConversationContext({
      modelMessages,
      uiMessages,
      topicId: 'topic-context-stress',
      budget,
      convert,
      generate
    })

    const firstSourceTokens = approximateTokenSize(modelMessages.map((message) => message.content).join('\n'))
    expect(first.action).toBe('checkpoint-created')
    expect(first.usageAfter.totalTokens).toBeLessThanOrEqual(budget.safeInputTokens)
    expect(firstSourceTokens).toBeGreaterThan(budget.compactionTriggerTokens)
    expect(first.checkpoint?.summary).toContain('ZEN-STRESS-001')
    expect(first.checkpoint?.summary).toContain('ZEN-STRESS-120')
    expect(generate).toHaveBeenCalled()

    const second = await manageConversationContext({
      modelMessages,
      uiMessages,
      topicId: 'topic-context-stress',
      budget,
      convert,
      generate
    })

    expect(second.action).toBe('checkpoint-reused')
    expect(second.messages[0].content).toContain('ZEN-STRESS-001')
    expect(loadContextCheckpoint('topic-context-stress')).toMatchObject({
      topicId: 'topic-context-stress',
      includedThroughMessageId: first.checkpoint?.includedThroughMessageId
    })
  })
})
