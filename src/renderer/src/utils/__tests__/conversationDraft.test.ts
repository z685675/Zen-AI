import type { Topic } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import {
  consumeLocallyVerifiedEmptyConversation,
  getChatTopicDraftCacheKey,
  hasUnsentConversationDraft,
  markLocallyVerifiedEmptyConversation,
  shouldDiscardEmptyConversation,
  sortConversationTopics
} from '../conversationDraft'

describe('conversation draft lifecycle', () => {
  it('uses a topic-scoped cache key', () => {
    expect(getChatTopicDraftCacheKey('topic:1')).toBe('chat-topic-draft:topic%3A1')
    expect(getChatTopicDraftCacheKey('topic:1')).not.toBe(getChatTopicDraftCacheKey('topic:2'))
  })

  it('only treats meaningful text as an unsent draft', () => {
    expect(hasUnsentConversationDraft('  pending message  ')).toBe(true)
    expect(hasUnsentConversationDraft('   ')).toBe(false)
    expect(hasUnsentConversationDraft(null)).toBe(false)
  })

  it('consumes locally verified empty conversations only once', () => {
    markLocallyVerifiedEmptyConversation('topic-empty')

    expect(consumeLocallyVerifiedEmptyConversation('topic-empty')).toBe(true)
    expect(consumeLocallyVerifiedEmptyConversation('topic-empty')).toBe(false)
  })

  it('discards only a fully idle conversation without messages or a draft', () => {
    expect(shouldDiscardEmptyConversation({ draft: '', isLoading: false, messageCount: 0 })).toBe(true)
    expect(shouldDiscardEmptyConversation({ draft: 'keep me', isLoading: false, messageCount: 0 })).toBe(false)
    expect(shouldDiscardEmptyConversation({ draft: '', isLoading: true, messageCount: 0 })).toBe(false)
    expect(shouldDiscardEmptyConversation({ draft: '', isLoading: false, messageCount: 1 })).toBe(false)
  })

  it('uses the same pinned and recency order as the conversation list', () => {
    const topic = (id: string, updatedAt: string, pinned = false) =>
      ({ id, updatedAt, createdAt: updatedAt, pinned }) as Topic

    const sorted = sortConversationTopics([
      topic('older', '2026-07-29T00:00:00.000Z'),
      topic('newer', '2026-07-31T00:00:00.000Z'),
      topic('pinned', '2026-07-28T00:00:00.000Z', true)
    ])

    expect(sorted.map((item) => item.id)).toEqual(['pinned', 'newer', 'older'])
  })
})
