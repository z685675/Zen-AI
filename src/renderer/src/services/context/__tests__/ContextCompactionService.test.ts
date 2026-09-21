import type { Model } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import type { ModelMessage } from 'ai'
import { approximateTokenSize } from 'tokenx'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createContextCompactionGenerator } from '../ContextCompactionModelService'
import {
  CHECKPOINT_SECTION_HEADINGS,
  manageConversationContext,
  manageStandaloneInput,
  serializeModelMessages,
  validateCheckpointSummary
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

const structuredCheckpoint = (body: string): string =>
  CHECKPOINT_SECTION_HEADINGS.map((heading) => `${heading}\n- ${body}`).join('\n')

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
    const generate = vi.fn(async () =>
      structuredCheckpoint('Keep the exact project ID ZEN-42 and continue the confirmed plan.')
    )

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

  it('invalidates a checkpoint when a compacted message is edited', async () => {
    const messagesById: Record<string, ModelMessage[]> = {
      u1: [{ role: 'user', content: 'original decision '.repeat(4_000) }],
      a1: [{ role: 'assistant', content: 'original answer '.repeat(4_000) }],
      u2: [{ role: 'user', content: 'recent question' }]
    }
    const uiMessages = [uiMessage('u1', 'user'), uiMessage('a1', 'assistant'), uiMessage('u2', 'user')]
    const convert = async (messages: Message[]) => messages.flatMap((message) => messagesById[message.id] ?? [])
    const generate = vi.fn(async () => structuredCheckpoint('Keep the edited conversation facts.'))

    await manageConversationContext({
      modelMessages: await convert(uiMessages),
      uiMessages,
      topicId: 'topic-edited-checkpoint',
      budget,
      convert,
      generate
    })
    generate.mockClear()

    uiMessages[0].updatedAt = '2026-09-22T01:00:00.000Z'
    const result = await manageConversationContext({
      modelMessages: await convert(uiMessages),
      uiMessages,
      topicId: 'topic-edited-checkpoint',
      budget,
      convert,
      generate
    })

    expect(result.action).toBe('checkpoint-created')
    expect(generate).toHaveBeenCalled()
  })

  it('serializes same-topic compaction operations to protect checkpoint writes', async () => {
    const messages = [uiMessage('u1', 'user'), uiMessage('a1', 'assistant'), uiMessage('u2', 'user')]
    const convert = async (sourceMessages: Message[]): Promise<ModelMessage[]> =>
      sourceMessages.map((message) => ({
        role: message.role,
        content:
          message.id === 'u2'
            ? `${message.id} recent concurrent checkpoint question`
            : `${message.id} concurrent checkpoint facts `.repeat(600)
      }))
    const modelMessages = await convert(messages)
    const generate = vi.fn(async () => structuredCheckpoint('Keep concurrent checkpoint facts.'))

    const [first, second] = await Promise.all(
      [1, 2].map(() =>
        manageConversationContext({
          modelMessages,
          uiMessages: messages,
          topicId: 'topic-concurrent-checkpoint',
          budget,
          convert,
          generate
        })
      )
    )

    expect(first.action).toBe('checkpoint-created')
    expect(second.action).toBe('checkpoint-reused')
    expect(generate).toHaveBeenCalled()
  })

  it('merges a previous checkpoint with only the messages after its boundary', async () => {
    const messagesById: Record<string, ModelMessage[]> = {
      u1: [{ role: 'user', content: '旧结论：使用方案 A。'.repeat(1_800) }],
      a1: [{ role: 'assistant', content: '旧答复：方案 A 已确认。'.repeat(1_800) }],
      u2: [{ role: 'user', content: '最近补充：先保留方案 A。'.repeat(1_800) }],
      a2: [{ role: 'assistant', content: '最近答复：收到。'.repeat(1_800) }],
      u3: [{ role: 'user', content: '新决定：改为方案 B，方案 A 作废。'.repeat(1_800) }],
      u4: [{ role: 'user', content: '请继续执行。' }]
    }
    const firstMessages = ['u1', 'a1', 'u2'].map((id) => uiMessage(id, id.startsWith('u') ? 'user' : 'assistant'))
    const convert = async (sourceMessages: Message[]): Promise<ModelMessage[]> =>
      sourceMessages.flatMap((message) => messagesById[message.id] ?? [])
    const updateContents: string[] = []
    let updatePromptSeen = false
    const generate = vi.fn(async (prompt: string, content: string) => {
      if (prompt.includes('older checkpoint') && prompt.includes('later conversation')) {
        updatePromptSeen = true
        updateContents.push(content)
        return structuredCheckpoint('CHECKPOINT-2：方案 B 已覆盖方案 A。')
      }
      if (prompt.includes('Merge checkpoint fragments')) {
        return structuredCheckpoint(
          updatePromptSeen ? 'CHECKPOINT-2：方案 B 已覆盖方案 A。' : 'CHECKPOINT-1：方案 A 是旧结论。'
        )
      }
      return structuredCheckpoint('CHECKPOINT-1：方案 A 是旧结论。')
    })

    const first = await manageConversationContext({
      modelMessages: await convert(firstMessages),
      uiMessages: firstMessages,
      topicId: 'topic-incremental-checkpoint',
      budget,
      convert,
      generate
    })
    expect(first.action).toBe('checkpoint-created')

    const allMessages = [
      ...firstMessages,
      uiMessage('a2', 'assistant'),
      uiMessage('u3', 'user'),
      uiMessage('u4', 'user')
    ]
    const second = await manageConversationContext({
      modelMessages: await convert(allMessages),
      uiMessages: allMessages,
      topicId: 'topic-incremental-checkpoint',
      budget,
      convert,
      generate
    })

    expect(second.action).toBe('checkpoint-created')
    expect(second.checkpoint?.summary).toContain('CHECKPOINT-2')
    expect(second.checkpoint?.includedThroughMessageId).toBe('u3')
    expect(second.messages[0].content).toContain('CHECKPOINT-2')
    expect(updateContents.some((content) => content.includes('CHECKPOINT-1'))).toBe(true)
    expect(updateContents.some((content) => content.includes('新决定：改为方案 B'))).toBe(true)
    expect(updateContents.every((content) => !content.includes('旧结论：使用方案 A。'))).toBe(true)
  })

  it('uses a local checkpoint when the auxiliary model returns empty text', async () => {
    const messages = [uiMessage('u1', 'user'), uiMessage('a1', 'assistant'), uiMessage('u2', 'user')]
    const convert = async (sourceMessages: Message[]): Promise<ModelMessage[]> =>
      sourceMessages.map((message) => ({
        role: message.role,
        content: `${message.id} 项目事实 ZEN-LOCAL-42 `.repeat(1_500)
      }))
    const generate = vi.fn(async () => '')

    const result = await manageConversationContext({
      modelMessages: await convert(messages),
      uiMessages: messages,
      topicId: 'topic-empty-checkpoint',
      budget,
      convert,
      generate
    })

    expect(result.action).toBe('checkpoint-created')
    expect(result.checkpoint?.summary).toContain('模型摘要暂时不可用')
    expect(result.messages.length).toBeGreaterThan(0)
    expect(result.usageAfter.totalTokens).toBeLessThanOrEqual(budget.safeInputTokens)
  })

  it('rejects an incomplete model checkpoint and keeps the important source anchor locally', () => {
    const source = '请记住项目编号 ZEN-CHECK-77，并继续处理 report.xlsx。'
    const invalid = '## Current goals\n- 只保留了一个章节。'
    const valid = structuredCheckpoint(`保留项目编号 ZEN-CHECK-77 和文件 report.xlsx。`)

    expect(validateCheckpointSummary(invalid, source).valid).toBe(false)
    expect(validateCheckpointSummary(valid, source)).toMatchObject({ valid: true, anchorCoverage: 1 })
  })

  it('uses a local checkpoint when the auxiliary model throws', async () => {
    const messages = [uiMessage('u1', 'user'), uiMessage('a1', 'assistant'), uiMessage('u2', 'user')]
    const convert = async (sourceMessages: Message[]): Promise<ModelMessage[]> =>
      sourceMessages.map((message) => ({
        role: message.role,
        content: `${message.id} 不应因整理失败而阻断回答 `.repeat(1_500)
      }))
    const generate = vi.fn(async () => {
      throw new Error('The model returned an empty context checkpoint.')
    })

    await expect(
      manageConversationContext({
        modelMessages: await convert(messages),
        uiMessages: messages,
        topicId: 'topic-failed-checkpoint',
        budget,
        convert,
        generate
      })
    ).resolves.toMatchObject({
      action: 'checkpoint-created',
      checkpoint: { summary: expect.stringContaining('模型摘要暂时不可用') }
    })
  })

  it('falls through every configured model before returning a local checkpoint', async () => {
    const messages = [uiMessage('u1', 'user'), uiMessage('a1', 'assistant'), uiMessage('u2', 'user')]
    const convert = async (sourceMessages: Message[]): Promise<ModelMessage[]> =>
      sourceMessages.map((message) => ({
        role: message.role,
        content: `${message.id} 连续故障时也必须继续回答 `.repeat(1_500)
      }))
    const models = ['model-a', 'model-b', 'model-c'].map(
      (id) => ({ id, provider: 'provider-a', name: id, group: 'default' }) as Model
    )
    const calls: string[] = []
    const generate = createContextCompactionGenerator({
      models,
      generate: async (model) => {
        calls.push(model.id)
        throw new Error(`${model.id} unavailable`)
      }
    })

    const result = await manageConversationContext({
      modelMessages: await convert(messages),
      uiMessages: messages,
      topicId: 'topic-all-checkpoint-models-failed',
      budget,
      convert,
      generate
    })

    expect(calls).toEqual(['model-a', 'model-b', 'model-c'])
    expect(result.action).toBe('checkpoint-created')
    expect(result.checkpoint?.summary).toContain('模型摘要暂时不可用')
    expect(result.usageAfter.totalTokens).toBeLessThanOrEqual(budget.safeInputTokens)
  })

  it('keeps application-injected webpage context across compaction', async () => {
    const messages = [uiMessage('u1', 'user'), uiMessage('a1', 'assistant'), uiMessage('u2', 'user')]
    const convert = async (sourceMessages: Message[]): Promise<ModelMessage[]> =>
      sourceMessages.map((message) => ({
        role: message.role,
        content: message.id === 'u2' ? '请总结 https://example.com' : 'old conversation '.repeat(2_500)
      }))
    const webpageContext: ModelMessage = {
      role: 'system',
      content: '<web-page-context>网页正文：这是压缩后仍必须保留的事实。</web-page-context>'
    }
    let sawWebpageContext = false
    const generate = vi.fn(async (_prompt: string, content: string) => {
      sawWebpageContext ||= content.includes('这是压缩后仍必须保留的事实')
      return structuredCheckpoint('网页正文：https://example.com 这是压缩后仍必须保留的事实。')
    })

    const result = await manageConversationContext({
      modelMessages: [...(await convert(messages)), webpageContext],
      uiMessages: messages,
      topicId: 'topic-webpage-compaction',
      budget,
      convert,
      additionalContextMessages: [webpageContext],
      generate
    })

    expect(result.action).toBe('checkpoint-created')
    expect(sawWebpageContext).toBe(true)
    expect(result.messages[0].content).toContain('这是压缩后仍必须保留的事实')
  })

  it('keeps the direct visual payload within the image budget after compaction', async () => {
    const messages = ['u1', 'u2', 'u3'].map((id) => uiMessage(id, 'user'))
    const convert = async (sourceMessages: Message[]): Promise<ModelMessage[]> =>
      sourceMessages.map((message) => ({
        role: 'user',
        content: [
          { type: 'text', text: message.id },
          ...Array.from({ length: 8 }, (_, index) => ({
            type: 'image' as const,
            image: `image-${message.id}-${index}`
          }))
        ]
      }))
    const modelMessages = await convert(messages)
    const visualBudget = {
      ...budget,
      safeInputTokens: 20_000,
      compactionTriggerTokens: 10_000,
      compactionTargetTokens: 8_000
    }
    const result = await manageConversationContext({
      modelMessages,
      uiMessages: messages,
      topicId: 'topic-image-budget',
      budget: visualBudget,
      convert,
      generate: vi.fn(async () => structuredCheckpoint('Keep visual context.'))
    })

    const imageCount = result.messages.reduce(
      (total, message) =>
        total + (Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image').length : 0),
      0
    )
    expect(result.action).toBe('checkpoint-created')
    expect(imageCount).toBeLessThanOrEqual(20)
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
