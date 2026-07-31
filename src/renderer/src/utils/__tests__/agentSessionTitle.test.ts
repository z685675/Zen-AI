import type { FileMetadata } from '@renderer/types'
import type { MainTextMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import {
  deriveAgentSessionFallbackTitle,
  isUnnamedAgentSessionName,
  normalizeAgentSessionTitle
} from '../agentSessionTitle'

const createMessage = (id: string, role: Message['role'], blockIds: string[]): Message => ({
  id,
  role,
  assistantId: 'agent-1',
  topicId: 'agent-session:session-1',
  createdAt: '2026-07-21T00:00:00.000Z',
  status: UserMessageStatus.SUCCESS,
  blocks: blockIds
})

const createTextBlock = (id: string, messageId: string, content: string): MainTextMessageBlock => ({
  id,
  messageId,
  type: MessageBlockType.MAIN_TEXT,
  content,
  createdAt: '2026-07-21T00:00:00.000Z',
  status: MessageBlockStatus.SUCCESS
})

describe('agent session title helpers', () => {
  it('recognizes localized placeholders but preserves meaningful manual names', () => {
    expect(isUnnamedAgentSessionName('Unnamed')).toBe(true)
    expect(isUnnamedAgentSessionName('\u672a\u547d\u540d')).toBe(true)
    expect(isUnnamedAgentSessionName('  ', 'Custom placeholder')).toBe(true)
    expect(isUnnamedAgentSessionName('Custom placeholder', 'Custom placeholder')).toBe(true)
    expect(isUnnamedAgentSessionName('\u9ed8\u8ba4\u8bdd\u9898', '\u9ed8\u8ba4\u8bdd\u9898')).toBe(true)
    expect(isUnnamedAgentSessionName('\u65d7\u8230\u7248 PPT \u89c4\u5212')).toBe(false)
  })

  it('derives a concise title from the first meaningful user line', () => {
    const message = createMessage('message-1', 'user', ['block-1'])
    const block = createTextBlock(
      'block-1',
      message.id,
      '/pptx\n# \u8bf7\u5236\u4f5c\u4e00\u4efd Zen AI \u65d7\u8230\u7248\u4ea7\u54c1\u53d1\u5e03\u4f1a PPT\n- \u9700\u8981 12 \u9875'
    )

    expect(deriveAgentSessionFallbackTitle({ messages: [message], blocks: [block] })).toBe(
      '\u8bf7\u5236\u4f5c\u4e00\u4efd Zen AI \u65d7\u8230\u7248\u4ea7\u54c1\u53d1\u5e03\u4f1a PPT'
    )
  })

  it('uses an attached file name when the user message has no text', () => {
    const message = createMessage('message-1', 'user', ['file-1'])
    const file = {
      origin_name: 'quarterly-report.pdf',
      name: 'stored.pdf'
    } as FileMetadata
    const block = {
      id: 'file-1',
      messageId: message.id,
      type: MessageBlockType.FILE,
      file,
      createdAt: '2026-07-21T00:00:00.000Z',
      status: MessageBlockStatus.SUCCESS
    } as MessageBlock

    expect(deriveAgentSessionFallbackTitle({ messages: [message], blocks: [block] })).toBe('quarterly-report.pdf')
  })

  it('falls back to a generic task title only when messages exist', () => {
    const message = createMessage('message-1', 'user', [])

    expect(deriveAgentSessionFallbackTitle({ messages: [message], blocks: [], genericTitle: 'Assistant Task' })).toBe(
      'Assistant Task'
    )
    expect(deriveAgentSessionFallbackTitle({ messages: [], blocks: [], genericTitle: 'Assistant Task' })).toBeNull()
  })

  it('normalizes generated titles and enforces the list length limit', () => {
    const title = normalizeAgentSessionTitle(
      '"A very long generated title that should be shortened before it is displayed in the session list"'
    )

    expect(title.length).toBeLessThanOrEqual(50)
    expect(title).not.toContain('"')
  })
})
