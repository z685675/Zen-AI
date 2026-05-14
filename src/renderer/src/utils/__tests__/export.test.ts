import type { Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/config/minapps', () => ({
  ORIGIN_DEFAULT_MIN_APPS: [],
  allMinApps: [],
  loadCustomMiniApp: async () => [],
  updateAllMinApps: vi.fn()
}))

vi.mock('@renderer/i18n', () => ({
  default: {
    t: vi.fn((key: string) => key)
  }
}))

vi.mock('@renderer/services/MessagesService', () => ({
  getMessageTitle: vi.fn(async () => 'Mock Message Title')
}))

vi.mock('@renderer/services/NotesService', () => ({
  addNote: vi.fn(async () => ({ path: '/tmp/mock-note.md', name: 'mock-note' }))
}))

vi.mock('@renderer/store/runtime', () => ({
  setExportState: vi.fn((payload) => ({ type: 'runtime/setExportState', payload }))
}))

vi.mock('@renderer/utils/messageUtils/find', () => ({
  getMainTextContent: vi.fn((message: Message & { _fullBlocks?: MessageBlock[] }) => {
    const block = message._fullBlocks?.find((item) => item.type === MessageBlockType.MAIN_TEXT)
    return (block as any)?.content || ''
  }),
  getThinkingContent: vi.fn((message: Message & { _fullBlocks?: MessageBlock[] }) => {
    const block = message._fullBlocks?.find((item) => item.type === MessageBlockType.THINKING)
    return (block as any)?.content || ''
  }),
  getCitationContent: vi.fn((message: Message & { _fullBlocks?: MessageBlock[] }) => {
    const blocks = message._fullBlocks?.filter((item) => item.type === MessageBlockType.CITATION) || []
    return blocks
      .map((_, index) => `[${index + 1}] [https://example${index + 1}.com](Example Citation ${index + 1})`)
      .join('\n\n')
  })
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  TopicManager: {
    getTopicMessages: vi.fn()
  }
}))

vi.mock('@renderer/utils/markdown', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    markdownToPlainText: vi.fn((value: string) => value)
  }
})

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      settings: {
        forceDollarMathInMarkdown: false,
        excludeCitationsInExport: false,
        standardizeCitationsInExport: true,
        showModelNameInMarkdown: false,
        showModelProviderInMarkdown: false
      },
      runtime: {
        export: {
          isExporting: false
        }
      }
    }),
    dispatch: vi.fn()
  }
}))

import { TopicManager } from '@renderer/hooks/useTopic'

import { copyMessageAsPlainText } from '../copy'
import {
  getTitleFromString,
  messagesToMarkdown,
  messageToMarkdown,
  messageToMarkdownWithReasoning,
  messageToPlainText,
  processCitations,
  topicToPlainText
} from '../export'

const createBlock = (messageId: string, type: MessageBlockType, content?: string): MessageBlock =>
  ({
    id: `${messageId}-${type}-${Math.random().toString(36).slice(2, 7)}`,
    messageId,
    type,
    createdAt: '2024-01-01T00:00:00Z',
    status: MessageBlockStatus.SUCCESS,
    ...(content !== undefined ? { content } : {})
  }) as MessageBlock

const createMessage = (
  role: 'user' | 'assistant' | 'system',
  blocks: MessageBlock[]
): Message & { _fullBlocks: MessageBlock[] } => ({
  id: `msg-${Math.random().toString(36).slice(2, 7)}`,
  role,
  assistantId: 'assistant-1',
  topicId: 'topic-1',
  createdAt: '2024-01-01T00:00:00Z',
  status: AssistantMessageStatus.SUCCESS,
  blocks: blocks.map((block) => block.id),
  _fullBlocks: blocks
})

describe('export utils', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', {
      value: {
        file: {
          read: vi.fn().mockResolvedValue('[]'),
          writeWithId: vi.fn()
        }
      },
      configurable: true
    })

    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn()
      },
      configurable: true
    })

    Object.defineProperty(window, 'toast', {
      value: {
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn()
      },
      configurable: true
    })
  })

  it('extracts titles from strings', () => {
    expect(getTitleFromString('Title. Remaining content')).toBe('Title')
    expect(getTitleFromString('Title, Remaining content')).toBe('Title')
    expect(getTitleFromString('Simple line')).toBe('Simple line')
    expect(getTitleFromString('\nabc', 2)).toBe('ab')
    expect(getTitleFromString('', 5)).toBe('')
  })

  it('removes and normalizes citation markers', () => {
    expect(processCitations('Text [1] after citation', 'remove')).toBe('Text after citation')
    expect(processCitations('Text [1] after citation', 'normalize')).toBe('Text [^1] after citation')
  })

  it('converts messages to markdown with and without reasoning', () => {
    const messageId = 'assistant-message'
    const blocks = [
      createBlock(messageId, MessageBlockType.MAIN_TEXT, 'Hello **world**'),
      createBlock(messageId, MessageBlockType.THINKING, '<think>\nReasoning content'),
      createBlock(messageId, MessageBlockType.CITATION, 'citation')
    ]
    const message = createMessage('assistant', blocks)

    const basic = messageToMarkdown(message)
    const withReasoning = messageToMarkdownWithReasoning(message)

    expect(basic).toContain('##')
    expect(basic).toContain('Hello **world**')
    expect(basic).toContain('[^1]: [https://example1.com](Example Citation 1)')
    expect(withReasoning).toContain('common.reasoning_content')
    expect(withReasoning).toContain('Reasoning content')
  })

  it('joins multiple messages as markdown', () => {
    const first = createMessage('user', [createBlock('user-1', MessageBlockType.MAIN_TEXT, 'First message')])
    const second = createMessage('assistant', [createBlock('assistant-1', MessageBlockType.MAIN_TEXT, 'Second message')])

    const result = messagesToMarkdown([first, second], false, true)

    expect(result).toContain('First message')
    expect(result).toContain('Second message')
    expect(result).toContain('\n---\n')
  })

  it('converts a single message to plain text and copies it', async () => {
    const message = createMessage('assistant', [createBlock('assistant-1', MessageBlockType.MAIN_TEXT, 'Plain text body')])

    expect(messageToPlainText(message)).toBe('Plain text body')

    await copyMessageAsPlainText(message)

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Plain text body')
    expect(window.toast.success).toHaveBeenCalled()
  })

  it('converts a topic to plain text using loaded messages', async () => {
    const message = createMessage('assistant', [createBlock('assistant-1', MessageBlockType.MAIN_TEXT, 'Topic message')])
    vi.mocked(TopicManager.getTopicMessages).mockResolvedValue([message])

    const topic = {
      id: 'topic-1',
      name: 'Topic title'
    } as Topic

    const result = await topicToPlainText(topic)

    expect(result).toContain('Topic title')
    expect(result).toContain('Assistant:')
    expect(result).toContain('Topic message')
  })
})
