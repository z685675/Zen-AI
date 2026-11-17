import type { Message } from '@renderer/types/newMessage'
import type { ModelMessage } from 'ai'
import { approximateTokenSize } from 'tokenx'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readCheckpointAttachments } from '../ContextAttachmentExcerptService'
import {
  CHECKPOINT_SECTION_HEADINGS,
  manageConversationContext,
  saveContextCheckpoint,
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
  contextWindowTokens: 200_000,
  maxOutputTokens: 32_000,
  source: 'fallback',
  confidence: 'low',
  safetyRatio: 0.9,
  fixedInputTokens: 2_000,
  safeInputTokens: 148_501,
  compactionTriggerTokens: 133_650,
  compactionTargetTokens: 86_130
}
const request = '学习参考表的分类标准，按研究内容、目标、成果将1-13号项目全部分类。'
const order = [7, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13]
const source = [
  ...order.map(
    (index) => `<file name="${index} 联合实验室.pdf">
<part page="1">
项目名称：联合实验室${index}，承担单位：单位${index}。
</part>
<part page="2">
${'行政一般说明和常规财务要求。'.repeat(2400)}
</part>
<part page="8">
研究内容：专属研究${index}；目标：专属目标${index}；成果：专属产出${index}。
</part>
<part page="20">
${'签章附表与其他一般规定。'.repeat(1800)}
</part>
</file>`
  ),
  '<file name="领域分类建议.xlsx">\n<part sheet="判定规则">\n前沿技术：机理研究；应用技术：技术产品；民生科技：公共需求。\n</part>\n</file>'
].join('\n')
const modelMessages: ModelMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: request },
      { type: 'text', text: source }
    ]
  }
]
const user = { id: 'u-batch', role: 'user', blocks: [] } as unknown as Message
const checkpoint = (text: string) => CHECKPOINT_SECTION_HEADINGS.map((heading) => `${heading}\n- ${text}`).join('\n')

describe('oversized PDF batch conversation regression', () => {
  beforeEach(() => storage.clear())

  it.each(['unavailable', 'incomplete'] as const)(
    'recovers all 14 attachments after %s remote summarization',
    async (mode) => {
      expect(approximateTokenSize(source)).toBeGreaterThan(300_000)
      const generate = vi.fn(async () => {
        if (mode === 'unavailable') throw new Error('summary unavailable')
        return checkpoint('仅记得7 联合实验室.pdf、12 联合实验室.pdf、13 联合实验室.pdf。')
      })
      const options = {
        topicId: `batch-${mode}`,
        uiMessages: [user],
        modelMessages,
        budget,
        convert: async (messages: Message[]) => (messages.length ? modelMessages : []),
        convertForCheckpoint: async (): Promise<ModelMessage[]> => [{ role: 'user', content: `${request}\n${source}` }],
        generate
      }
      const result = await manageConversationContext(options)
      expect(result.usedLocalCheckpoint).toBe(true)
      expect(result.usageAfter.totalTokens).toBeLessThanOrEqual(budget.safeInputTokens)
      expect(result.checkpoint?.attachmentCoverage).toHaveLength(14)
      expect(
        result.checkpoint?.attachmentCoverage?.every((file) => file.mode === 'full' || file.mode === 'excerpt')
      ).toBe(true)
      const text = result.messages.map((message) => String(message.content)).join('\n')
      expect(text).toContain(request)
      for (const index of order) {
        expect(text).toContain(`${index} 联合实验室.pdf`)
        expect(text).toContain(`专属研究${index}`)
        expect(text).toContain(`专属产出${index}`)
      }
      expect(text).toContain('sheet="判定规则"')
      expect(text).toContain('page="8"')
      const calls = generate.mock.calls.length
      const retry = await manageConversationContext(options)
      expect(retry.action).toBe('checkpoint-reused')
      expect(retry.checkpoint?.attachmentCoverage).toEqual(result.checkpoint?.attachmentCoverage)
      expect(generate).toHaveBeenCalledTimes(calls)
      expect(retry.usageAfter.totalTokens).toBeLessThanOrEqual(budget.safeInputTokens)
      // Switching model/output settings may reduce the available input window.
      // The old large checkpoint must be rebuilt, not reused or allowed to fail
      // with an empty transcript at its already-consumed message boundary.
      const smallerBudget = {
        ...budget,
        safeInputTokens: 74_000,
        compactionTriggerTokens: 66_000,
        compactionTargetTokens: 43_000
      }
      const smaller = await manageConversationContext({ ...options, budget: smallerBudget })
      expect(smaller.usageAfter.totalTokens).toBeLessThanOrEqual(smallerBudget.safeInputTokens)
      expect(smaller.checkpoint?.attachmentCoverage).toHaveLength(14)
      for (const index of order) expect(smaller.checkpoint?.summary).toContain(`专属研究${index}`)
    }
  )

  it('rejects a well-formatted remote summary which silently drops middle Chinese files', () => {
    const summary = checkpoint('仅保留7 联合实验室.pdf、12 联合实验室.pdf、13 联合实验室.pdf及领域分类建议.xlsx。')
    const validation = validateCheckpointSummary(summary, source)
    expect(validation.valid).toBe(false)
    expect(validation.missingAnchors).toContain('6 联合实验室.pdf')
    const complete = checkpoint(
      readCheckpointAttachments(source)
        .map((file) => file.name)
        .join('\n')
    )
    expect(validateCheckpointSummary(complete, source).valid).toBe(true)
  })

  it('repairs a previously saved incomplete checkpoint from local attachments instead of reusing it', async () => {
    const topicId = 'old-incomplete-pdf-checkpoint'
    saveContextCheckpoint({
      version: 1,
      topicId,
      includedThroughMessageId: user.id,
      sourceFingerprint: 'old',
      summary: checkpoint('仅记得7 联合实验室.pdf、12 联合实验室.pdf、13 联合实验室.pdf与领域分类建议.xlsx。'),
      sourceTokens: 300_000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    const richConvert = vi.fn(async (): Promise<ModelMessage[]> => [{ role: 'user', content: `${request}\n${source}` }])
    const result = await manageConversationContext({
      topicId,
      uiMessages: [user],
      modelMessages,
      budget,
      attachmentNamesByMessage: new Map([[user.id, readCheckpointAttachments(source).map((file) => file.name)]]),
      convert: async (messages) => (messages.length ? modelMessages : []),
      convertForCheckpoint: richConvert,
      generate: async () => {
        throw new Error('summary unavailable')
      }
    })
    expect(richConvert).toHaveBeenCalledWith([user], { rereadAnsweredAttachments: true })
    expect(result.checkpoint?.attachmentCoverage).toHaveLength(14)
    expect(result.checkpoint?.summary).toContain('专属研究6')
    expect(result.usageAfter.totalTokens).toBeLessThanOrEqual(budget.safeInputTokens)
  })

  it('preserves old file evidence when a later checkpoint falls back during a follow-up', async () => {
    const smallBudget: ContextBudget = {
      ...budget,
      safeInputTokens: 10_800,
      compactionTriggerTokens: 6_000,
      compactionTargetTokens: 3_500
    }
    const oldSource = source.replaceAll(/行政一般说明和常规财务要求。|签章附表与其他一般规定。/g, '')
    const oldMessages: ModelMessage[] = [
      { role: 'user', content: `${request}\n${oldSource}\n${'其他原始资料。'.repeat(5000)}` }
    ]
    const generate = vi.fn(async (): Promise<string> => {
      throw new Error('unavailable')
    })
    const first = await manageConversationContext({
      topicId: 'batch-follow-up',
      uiMessages: [user],
      modelMessages: oldMessages,
      budget: smallBudget,
      convert: async () => oldMessages,
      generate
    })
    expect(first.checkpoint?.summary).toContain('专属研究6')
    const follow = { id: 'u-next', role: 'user', blocks: [] } as unknown as Message
    const followText = '重新核对第6号项目。' + '补充研究问题。'.repeat(3000)
    const followMessages: ModelMessage[] = [{ role: 'user', content: followText }]
    const next = await manageConversationContext({
      topicId: 'batch-follow-up',
      uiMessages: [user, follow],
      modelMessages: [...oldMessages, ...followMessages],
      budget: smallBudget,
      convert: async (messages) =>
        messages.flatMap((message) => (message.id === follow.id ? followMessages : oldMessages)),
      generate
    })
    expect(next.checkpoint?.summary).toContain('专属研究6')
    expect(next.checkpoint?.attachmentCoverage).toHaveLength(14)
    expect(next.usageAfter.totalTokens).toBeLessThanOrEqual(smallBudget.safeInputTokens)
  })
})
