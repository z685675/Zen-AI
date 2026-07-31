import type { Topic } from '@renderer/types'

const locallyVerifiedEmptyConversationIds = new Set<string>()

export const getChatTopicDraftCacheKey = (topicId: string): string => `chat-topic-draft:${encodeURIComponent(topicId)}`

export const hasUnsentConversationDraft = (draft: unknown): boolean =>
  typeof draft === 'string' && draft.trim().length > 0

export const markLocallyVerifiedEmptyConversation = (conversationId: string): void => {
  locallyVerifiedEmptyConversationIds.add(conversationId)
}

export const consumeLocallyVerifiedEmptyConversation = (conversationId: string): boolean =>
  locallyVerifiedEmptyConversationIds.delete(conversationId)

export const sortConversationTopics = (topics: Topic[]): Topic[] =>
  [...topics].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1

    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime()
    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime()
    return bTime - aTime
  })

export const shouldDiscardEmptyConversation = ({
  draft,
  isLoading,
  messageCount
}: {
  draft: unknown
  isLoading: boolean
  messageCount: number
}): boolean => messageCount === 0 && !isLoading && !hasUnsentConversationDraft(draft)
