import type { Message } from '@renderer/types/newMessage'
import type { ModelMessage } from 'ai'
import { approximateTokenSize } from 'tokenx'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CHECKPOINT_SECTION_HEADINGS,
  loadContextCheckpoint,
  manageConversationContext
} from '../ContextCompactionService'
import { type ContextBudget, createContextBudget } from '../ContextWindowService'

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

  it('handles a near-200K transcript at the real 200K model budget and compacts a later batch incrementally', async () => {
    const largeBudget: ContextBudget = createContextBudget({
      model: {
        id: 'gpt-stress-model',
        name: 'Stress model',
        provider: 'stress-provider',
        group: 'default',
        contextWindowTokens: 200_000,
        maxOutputTokens: 16_000
      },
      requestedOutputTokens: 16_000
    })
    const ids = Array.from({ length: 300 }, (_, index) => `large-turn-${index + 1}`)
    const uiMessages = ids.map((id, index) => uiMessage(id, index % 2 === 0 ? 'user' : 'assistant'))
    const convert = async (messages: Message[]): Promise<ModelMessage[]> =>
      messages.map((message) => {
        const turn = Number(message.id.slice('large-turn-'.length))
        return {
          role: message.role,
          content: `${message.id} LONG-CONTEXT-ANCHOR-${String(turn).padStart(4, '0')} stable historical facts `
            .repeat(38)
            .concat('Historical intent and confirmed decisions remain intact.')
        }
      })
    const modelMessages = await convert(uiMessages)
    const generate = vi.fn(async (_prompt: string, content: string) => {
      const newTranscriptIndex = content.indexOf('<new-transcript>')
      const relevantContent =
        newTranscriptIndex >= 0 ? content.slice(newTranscriptIndex + '<new-transcript>'.length) : content
      const foundAnchors = [...new Set(relevantContent.match(/LONG-CONTEXT-ANCHOR-\d+/g) ?? [])]
      const anchors = [...new Set([...foundAnchors.slice(0, 24), ...foundAnchors.slice(-1)])].join(', ')
      return CHECKPOINT_SECTION_HEADINGS.map((heading) => `${heading}\n- Preserve exact identifiers: ${anchors}.`).join(
        '\n'
      )
    })

    const sourceTokens = approximateTokenSize(modelMessages.map((message) => message.content).join('\n'))
    expect(largeBudget.contextWindowTokens).toBe(200_000)
    expect(largeBudget.safeInputTokens).toBe(165_600)
    expect(sourceTokens).toBeGreaterThan(195_000)
    expect(sourceTokens).toBeLessThan(200_000)

    const first = await manageConversationContext({
      modelMessages,
      uiMessages,
      topicId: 'topic-context-stress-200k',
      budget: largeBudget,
      convert,
      generate
    })

    expect(first.action).toBe('checkpoint-created')
    expect(first.usedLocalCheckpoint).toBe(false)
    expect(first.usageAfter.totalTokens).toBeLessThanOrEqual(largeBudget.safeInputTokens)
    expect(first.checkpoint?.summary).toContain('LONG-CONTEXT-ANCHOR-0001')
    expect(first.checkpoint?.includedThroughMessageId).toBeDefined()

    const second = await manageConversationContext({
      modelMessages,
      uiMessages,
      topicId: 'topic-context-stress-200k',
      budget: largeBudget,
      convert,
      generate
    })

    expect(second.action).toBe('checkpoint-reused')
    expect(second.usageAfter.totalTokens).toBeLessThanOrEqual(largeBudget.safeInputTokens)
    expect(second.messages[0].content).toContain('LONG-CONTEXT-ANCHOR-0001')

    const appendedIds = Array.from({ length: 250 }, (_, index) => `large-turn-${index + 301}`)
    const appendedUiMessages = appendedIds.map((id, index) => uiMessage(id, index % 2 === 0 ? 'user' : 'assistant'))
    const appendedModelMessages = await convert(appendedUiMessages)
    const third = await manageConversationContext({
      modelMessages: [...modelMessages, ...appendedModelMessages],
      uiMessages: [...uiMessages, ...appendedUiMessages],
      topicId: 'topic-context-stress-200k',
      budget: largeBudget,
      convert,
      generate
    })

    expect(third.action).toBe('checkpoint-created')
    expect(third.usedLocalCheckpoint).toBe(false)
    expect(third.usageAfter.totalTokens).toBeLessThanOrEqual(largeBudget.safeInputTokens)
    expect(third.checkpoint?.summary).toContain('LONG-CONTEXT-ANCHOR-0408')
    expect(third.checkpoint?.sourceTokens).toBeGreaterThan(first.checkpoint?.sourceTokens ?? 0)
  }, 60_000)
})
