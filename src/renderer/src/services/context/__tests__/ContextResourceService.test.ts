import type { ContextResource } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const storedResources: ContextResource[] = []

vi.mock('@renderer/databases', () => ({
  default: {
    context_resources: {
      put: async (resource: ContextResource) => {
        storedResources.push(resource)
      },
      bulkDelete: async (ids: string[]) => {
        for (let index = storedResources.length - 1; index >= 0; index -= 1) {
          if (ids.includes(storedResources[index].id)) {
            storedResources.splice(index, 1)
          }
        }
      },
      where: (field: keyof ContextResource) => ({
        equals: (value: unknown) => {
          const matching = () => storedResources.filter((resource) => resource[field] === value)
          return {
            first: async () => matching()[0],
            and: (predicate: (resource: ContextResource) => boolean) => ({
              first: async () => matching().find(predicate)
            }),
            toArray: async () => matching(),
            delete: async () => {
              for (let index = storedResources.length - 1; index >= 0; index -= 1) {
                if (storedResources[index][field] === value) {
                  storedResources.splice(index, 1)
                }
              }
            }
          }
        }
      })
    }
  }
}))

import {
  chunkContextResourceText,
  deleteContextResourcesForMessages,
  formatResourceSearchContext,
  saveStructuredFileContextResource,
  saveTextContextResource,
  searchContextResources
} from '../ContextResourceService'

describe('ContextResourceService', () => {
  beforeEach(() => {
    storedResources.length = 0
  })

  it('chunks long text without dropping content', () => {
    const text = Array.from({ length: 20 }, (_, index) => `Section ${index}\n${'content '.repeat(100)}`).join('\n\n')
    const chunks = chunkContextResourceText(text, 300)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.text).join('\n\n')).toContain('Section 0')
    expect(chunks.map((chunk) => chunk.text).join('\n\n')).toContain('Section 19')
    expect(chunks.every((chunk) => chunk.tokenEstimate > 0)).toBe(true)
  })

  it('retrieves exact identifiers from persisted resources', async () => {
    const conversationId = `resource-test-${Date.now()}`
    await saveTextContextResource({
      conversationId,
      sourceName: 'research-notes.txt',
      text: `General introduction.

The exact project identifier is ZEN-CONTEXT-94731 and the approved budget is 18,640 yuan.

Closing notes.`
    })

    const results = await searchContextResources({
      conversationId,
      query: 'What was the identifier ZEN-CONTEXT-94731?'
    })

    expect(results[0]?.chunk.text).toContain('ZEN-CONTEXT-94731')
    expect(formatResourceSearchContext(results)).toContain('research-notes.txt')
  })

  it('uses semantic aliases when the query and source use different wording', async () => {
    const conversationId = `resource-semantic-${Date.now()}`
    await saveTextContextResource({
      conversationId,
      sourceName: 'finance-plan.txt',
      text: '项目的批准预算为 86 万元，主要投入内容制作和线下活动。'
    })

    const results = await searchContextResources({
      conversationId,
      query: '这个方案预计需要花费多少钱？'
    })

    expect(results[0]?.sourceName).toBe('finance-plan.txt')
    expect(results[0]?.semanticScore).toBeGreaterThan(0)
  })

  it('preserves structured locators and reuses parsed file content', async () => {
    const read = vi.fn(async () => ({
      parserVersion: 1,
      format: 'pptx',
      sections: [
        {
          text: '年度增长目标为 35%。',
          metadata: { slide: 8, section: '年度目标' }
        }
      ]
    }))

    const first = await saveStructuredFileContextResource({
      conversationId: 'structured-topic',
      sourceMessageId: 'message-1',
      sourceName: 'annual-plan.pptx',
      fileFingerprint: 'file-1:100:pptx',
      read
    })
    const second = await saveStructuredFileContextResource({
      conversationId: 'structured-topic',
      sourceMessageId: 'message-1',
      sourceName: 'annual-plan.pptx',
      fileFingerprint: 'file-1:100:pptx',
      read
    })

    expect(first.resource.chunks[0].metadata).toMatchObject({ slide: 8, section: '年度目标' })
    expect(second.cacheHit).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('deletes resources associated with removed messages', async () => {
    const conversationId = `resource-delete-${Date.now()}`
    await saveTextContextResource({
      conversationId,
      sourceName: 'message-one',
      sourceMessageId: 'message-1',
      text: 'Keep this exact source relationship.'
    })
    await saveTextContextResource({
      conversationId,
      sourceName: 'message-two',
      sourceMessageId: 'message-2',
      text: 'This resource should remain.'
    })

    await deleteContextResourcesForMessages(conversationId, ['message-1'])

    expect(storedResources.map((resource) => resource.sourceMessageId)).toEqual(['message-2'])
  })
})
