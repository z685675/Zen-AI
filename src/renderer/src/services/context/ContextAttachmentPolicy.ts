import type { Message } from '@renderer/types/newMessage'

/**
 * Return user-message IDs that already have a completed assistant response.
 * Checkpointing can rely on that conversation instead of re-reading the same
 * attachment; unresolved uploads still go through normal extraction.
 */
export const getCompletedAssistantResponseSourceIds = (
  messages: Pick<Message, 'role' | 'status' | 'askId'>[]
): Set<string> => {
  const sourceIds = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant' && message.status === 'success' && message.askId) {
      sourceIds.add(message.askId)
    }
  }
  return sourceIds
}

export const createAttachmentReference = (name: string, kind: 'file' | 'image'): string => {
  const label = kind === 'file' ? '附件' : '图片'
  return `[${label}：${name}；本轮已有助手回复。整理上下文时以用户问题、助手答复和用户后续纠正为主，不重复解析原件；原件仍保留在本地，之后需要精确细节时可再查阅。]`
}
