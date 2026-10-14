import type { ContextTelemetry } from '@renderer/types'
import { ERROR_I18N_KEY_STREAM_PAUSED } from '@renderer/types/error'
import {
  AssistantMessageStatus,
  type ErrorMessageBlock,
  type Message,
  type MessageBlock,
  MessageBlockStatus,
  MessageBlockType
} from '@renderer/types/newMessage'
import { isUserStoppedMessage } from '@renderer/utils/agentCancellation'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loading: true,
  lastUser: 'user',
  blocks: {} as Record<string, any>,
  telemetry: undefined as ContextTelemetry | undefined,
  listeners: new Set<(value: ContextTelemetry) => void>(),
  abort: vi.fn()
}))
vi.mock('@renderer/store', () => ({
  useAppSelector: (selector: any) =>
    selector({
      messages: {
        messageIdsByTopic: { topic: [mocks.lastUser, 'reply'] },
        entities: { [mocks.lastUser]: { role: 'user' } }
      },
      messageBlocks: { entities: mocks.blocks }
    })
}))
vi.mock('@renderer/hooks/useMessageOperations', () => ({ selectNewTopicLoading: () => mocks.loading }))
vi.mock('@renderer/services/context/ContextTelemetryService', () => ({ getContextTelemetry: () => mocks.telemetry }))
vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { CONTEXT_STATUS_UPDATED: 'status' },
  EventEmitter: {
    on: (_name: string, listener: any) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
}))
vi.mock('@renderer/utils/abortController', () => ({ abortCompletion: mocks.abort }))
vi.mock('@renderer/services/SpanManagerService', () => ({ pauseTrace: vi.fn(async () => undefined) }))
vi.mock('react-i18next', async () => {
  const { default: locale } = await import('@renderer/i18n/locales/zh-cn.json')
  return {
    initReactI18next: { type: '3rdParty', init: vi.fn() },
    useTranslation: () => ({
      t: (key: string, values?: Record<string, unknown>) => {
        const text = (locale.new_assistant as Record<string, string>)[key.split('.').at(-1)!] ?? key
        return text.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(values?.[name] ?? ''))
      }
    })
  }
})

import { useSmoothStream } from '@renderer/hooks/useSmoothStream'

import AgentTaskProgress from '../AgentTaskProgress'
import AgentStoppedNotice from '../Blocks/AgentStoppedNotice'
import { hasVisibleAssistantActivity, taskElapsedSeconds } from '../taskProgressStatus'
import { useRenderedMessageActivity } from '../useRenderedMessageActivity'

const message: Message = {
  id: 'reply',
  role: 'assistant',
  assistantId: 'agent',
  topicId: 'topic',
  askId: 'user',
  createdAt: '2026-10-11T00:00:00Z',
  status: AssistantMessageStatus.PROCESSING,
  blocks: []
}
const publish = (stage: string, id = 'reply', topic = 'topic') => {
  act(() =>
    mocks.listeners.forEach((listener) =>
      listener({ conversationId: topic, lastAction: `opencode-status:${id}:${stage}` } as ContextTelemetry)
    )
  )
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(message.createdAt))
  mocks.loading = true
  mocks.lastUser = 'user'
  mocks.blocks = {}
  mocks.telemetry = undefined
  mocks.listeners.clear()
  mocks.abort.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('visible, honest new assistant waiting', () => {
  it('acknowledges immediately, updates real stages and exposes one stop action', () => {
    render(<AgentTaskProgress message={message} hasRenderedContent={false} />)
    expect(screen.getByText('请求已收到，正在准备任务')).toBeVisible()
    publish('starting')
    expect(screen.getByText('正在启动本地助手')).toBeVisible()
    publish('waiting_model')
    expect(screen.getByText('请求已发出，正在等待模型响应')).toBeVisible()
    act(() => {
      vi.advanceTimersByTime(31_000)
    })
    expect(screen.getByText('已用时 31 秒')).toBeVisible()
    expect(screen.getByText(/无需重复发送/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(mocks.abort).toHaveBeenCalledExactlyOnceWith('user')
    expect(screen.getByText('正在停止…')).toBeVisible()
    expect(screen.getByRole('button', { name: '停止' })).toBeDisabled()
  })
  it('ignores other turns/conversations and removes timers/listeners when leaving', () => {
    mocks.telemetry = { conversationId: 'topic', lastAction: 'opencode-status:old:retrying' } as ContextTelemetry
    const { unmount } = render(<AgentTaskProgress message={message} hasRenderedContent={false} />)
    expect(screen.getByText('请求已收到，正在准备任务')).toBeVisible()
    publish('retrying', 'reply', 'other-topic')
    expect(screen.queryByText(/服务暂时/)).not.toBeInTheDocument()
    unmount()
    expect(mocks.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(new Date('2026-10-11T00:00:12Z'))
    render(<AgentTaskProgress message={message} hasRenderedContent={false} />)
    expect(screen.getByText('已用时 12 秒')).toBeVisible()
  })
  it('hides terminal, historical and not-actually-running messages', () => {
    const { rerender, container } = render(
      <AgentTaskProgress message={{ ...message, status: AssistantMessageStatus.SUCCESS }} hasRenderedContent={false} />
    )
    expect(container).toBeEmptyDOMElement()
    rerender(
      <AgentTaskProgress message={{ ...message, status: AssistantMessageStatus.ERROR }} hasRenderedContent={false} />
    )
    expect(container).toBeEmptyDOMElement()
    mocks.lastUser = 'new-user'
    rerender(<AgentTaskProgress message={message} hasRenderedContent={false} />)
    expect(container).toBeEmptyDOMElement()
    mocks.lastUser = 'user'
    mocks.loading = false
    rerender(<AgentTaskProgress message={message} hasRenderedContent={false} />)
    expect(container).toBeEmptyDOMElement()
  })
  it.each([MessageBlockType.MAIN_TEXT, MessageBlockType.THINKING])(
    'removes the initial waiting card as soon as %s appears and cleans up its timer/listener',
    (type) => {
      const { rerender, container } = render(<AgentTaskProgress message={message} hasRenderedContent={false} />)
      publish('waiting_model')
      expect(screen.getByRole('status')).toBeVisible()
      act(() => {
        vi.advanceTimersByTime(21_000)
      })
      mocks.blocks.output = { type, content: '开始处理你的请求', status: MessageBlockStatus.STREAMING }
      const answering = { ...message, blocks: ['output'] }
      rerender(<AgentTaskProgress message={answering} hasRenderedContent />)
      expect(container).toBeEmptyDOMElement()
      expect(mocks.listeners.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)

      // A subsequent model call/retry must not bring the initial blank-period UI back.
      mocks.telemetry = {
        conversationId: 'topic',
        lastAction: 'opencode-status:reply:waiting_model'
      } as ContextTelemetry
      rerender(<AgentTaskProgress message={answering} hasRenderedContent />)
      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      expect(container).toBeEmptyDOMElement()
    }
  )
  it.each(['pending', 'invoking', 'streaming', 'done', 'error', 'cancelled'])(
    'counts a visible tool call in %s state as activity, not an empty response',
    (status) => {
      mocks.blocks.tool = {
        type: MessageBlockType.TOOL,
        status: MessageBlockStatus.PROCESSING,
        metadata: { rawMcpToolResponse: { status, tool: { name: 'Read' } } }
      }
      vi.setSystemTime(new Date('2026-10-11T00:00:52Z'))
      const { container } = render(<AgentTaskProgress message={{ ...message, blocks: ['tool'] }} hasRenderedContent />)
      expect(container).toBeEmptyDOMElement()
      expect(mocks.listeners.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it('never brings waiting back between tools or on remount after a completed file-producing tool', () => {
    const { rerender, container, unmount } = render(<AgentTaskProgress message={message} hasRenderedContent={false} />)
    act(() => {
      vi.advanceTimersByTime(52_000)
    })
    expect(screen.getByText(/无需重复发送/)).toBeVisible()
    mocks.blocks.tool = {
      type: MessageBlockType.TOOL,
      status: MessageBlockStatus.SUCCESS,
      metadata: {
        rawMcpToolResponse: {
          status: 'done',
          tool: { name: 'present_files' },
          response: { structuredContent: { files: [{ path: 'C:\\work\\测试.docx', name: '测试.docx' }] } }
        }
      }
    }
    const withFile = { ...message, blocks: ['tool'] }
    rerender(<AgentTaskProgress message={withFile} hasRenderedContent />)
    expect(container).toBeEmptyDOMElement()
    for (const stage of ['busy', 'retrying', 'compacting', 'waiting_model', 'waiting_permission']) {
      mocks.telemetry = { conversationId: 'topic', lastAction: `opencode-status:reply:${stage}` } as ContextTelemetry
      rerender(<AgentTaskProgress message={withFile} hasRenderedContent />)
      expect(container).toBeEmptyDOMElement()
    }
    mocks.blocks.nextTool = {
      type: MessageBlockType.TOOL,
      status: MessageBlockStatus.PROCESSING,
      metadata: { rawMcpToolResponse: { status: 'invoking', tool: { name: 'python_execute' } } }
    }
    rerender(<AgentTaskProgress message={{ ...withFile, blocks: ['tool', 'nextTool'] }} hasRenderedContent />)
    expect(container).toBeEmptyDOMElement()
    unmount()
    const restored = render(<AgentTaskProgress message={withFile} hasRenderedContent />)
    expect(restored.container).toBeEmptyDOMElement()
    expect(mocks.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps empty/unresolved placeholders in the initial waiting period', () => {
    mocks.blocks.placeholder = { type: MessageBlockType.UNKNOWN, status: MessageBlockStatus.PROCESSING }
    mocks.blocks.text = { type: MessageBlockType.MAIN_TEXT, content: ' \n ', status: MessageBlockStatus.STREAMING }
    mocks.blocks.thinking = { type: MessageBlockType.THINKING, content: '', status: MessageBlockStatus.PROCESSING }
    mocks.blocks.tool = { type: MessageBlockType.TOOL, status: MessageBlockStatus.PENDING }
    render(
      <AgentTaskProgress
        message={{ ...message, blocks: ['missing', 'placeholder', 'text', 'thinking', 'tool'] }}
        hasRenderedContent={false}
      />
    )
    expect(screen.getByText('请求已收到，正在准备任务')).toBeVisible()
    publish('waiting_model')
    expect(screen.getByText('请求已发出，正在等待模型响应')).toBeVisible()
    act(() => {
      vi.advanceTimersByTime(31_000)
    })
    expect(screen.getByText(/无需重复发送/)).toBeVisible()
  })
  it('retains honest permission/retry/compaction status only before visible output', () => {
    const { rerender, container } = render(<AgentTaskProgress message={message} hasRenderedContent={false} />)
    publish('waiting_permission')
    expect(screen.getByText('等待你确认工具操作')).toBeVisible()
    act(() => {
      vi.advanceTimersByTime(31_000)
    })
    expect(screen.queryByText(/无需重复发送/)).not.toBeInTheDocument()
    publish('retrying')
    expect(screen.getByRole('status')).toBeVisible()
    publish('compacting')
    expect(screen.getByRole('status')).toBeVisible()
    mocks.blocks.tool = {
      type: MessageBlockType.TOOL,
      status: MessageBlockStatus.PENDING,
      metadata: { rawMcpToolResponse: { status: 'pending', tool: { name: 'Write' } } }
    }
    rerender(<AgentTaskProgress message={{ ...message, blocks: ['tool'] }} hasRenderedContent />)
    expect(container).toBeEmptyDOMElement()
  })
  it('shows initial waiting again for a genuinely new turn without inheriting earlier activity', () => {
    mocks.blocks.text = {
      type: MessageBlockType.MAIN_TEXT,
      content: '上一轮的答案',
      status: MessageBlockStatus.SUCCESS
    }
    const { rerender, container } = render(
      <AgentTaskProgress message={{ ...message, blocks: ['text'] }} hasRenderedContent />
    )
    expect(container).toBeEmptyDOMElement()
    mocks.lastUser = 'new-user'
    mocks.telemetry = { conversationId: 'topic', lastAction: 'opencode-status:reply:waiting_model' } as ContextTelemetry
    rerender(
      <AgentTaskProgress message={{ ...message, id: 'new-reply', askId: 'new-user' }} hasRenderedContent={false} />
    )
    expect(screen.getByText('请求已收到，正在准备任务')).toBeVisible()
    expect(screen.getByRole('button', { name: '停止' })).toBeEnabled()
  })
  it.each([
    { type: MessageBlockType.FILE, file: { id: 'output', name: '测试.docx' } },
    { type: MessageBlockType.IMAGE, url: 'file:///work/output.png', status: MessageBlockStatus.SUCCESS },
    {
      type: MessageBlockType.IMAGE,
      metadata: { generateImageResponse: { images: ['data:image/png;base64,test'] } },
      status: MessageBlockStatus.SUCCESS
    },
    { type: MessageBlockType.VIDEO, filePath: 'C:\\work\\output.mp4' },
    { type: MessageBlockType.COMPACT, content: '已整理上下文' },
    { type: MessageBlockType.ERROR, error: { message: '工具执行失败' } }
  ])('treats meaningful $type output as visible activity', (block) => {
    expect(hasVisibleAssistantActivity([block as MessageBlock])).toBe(true)
    mocks.blocks.output = block
    const { container } = render(<AgentTaskProgress message={{ ...message, blocks: ['output'] }} hasRenderedContent />)
    expect(container).toBeEmptyDOMElement()
  })
  it('does not count an empty image placeholder as produced content', () => {
    expect(
      hasVisibleAssistantActivity([
        { type: MessageBlockType.IMAGE, status: MessageBlockStatus.SUCCESS } as MessageBlock
      ])
    ).toBe(false)
  })
  it('keeps the status until received text is rendered, without claiming that no output has arrived', () => {
    const { rerender, container } = render(<AgentTaskProgress message={message} hasRenderedContent={false} />)
    publish('waiting_model')
    act(() => {
      vi.advanceTimersByTime(31_000)
    })
    mocks.blocks.text = {
      type: MessageBlockType.MAIN_TEXT,
      content: '已经收到的首段文字',
      status: MessageBlockStatus.STREAMING
    }
    const received = { ...message, blocks: ['text'] }
    rerender(<AgentTaskProgress message={received} hasRenderedContent={false} />)
    expect(screen.getByRole('status')).toHaveTextContent('模型正在输出')
    expect(screen.queryByText(/没有新的输出/)).not.toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(screen.getByRole('status')).toHaveTextContent('模型正在输出')
    expect(screen.getByRole('button', { name: '停止' })).toBeEnabled()
    rerender(<AgentTaskProgress message={received} hasRenderedContent />)
    expect(container).toBeEmptyDOMElement()
    expect(mocks.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bridges delayed smooth-stream rendering with a real DOM acknowledgement, without a blank response', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback)
        return frames.length
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    function StreamedReply({ content = '' }) {
      const root = useRef<HTMLDivElement>(null)
      const previous = useRef('')
      const [displayed, setDisplayed] = useState('')
      const { addChunk } = useSmoothStream({ onUpdate: setDisplayed, streamDone: false })
      const rendered = useRenderedMessageActivity(root, message.id, true)
      useEffect(() => {
        addChunk(content.slice(previous.current.length))
        previous.current = content
      }, [addChunk, content])
      return (
        <>
          <div ref={root}>
            <ReactMarkdown>{displayed}</ReactMarkdown>
          </div>
          <AgentTaskProgress message={{ ...message, blocks: ['text'] }} hasRenderedContent={rendered} />
        </>
      )
    }
    try {
      const { rerender, unmount } = render(<StreamedReply />)
      publish('waiting_model')
      mocks.blocks.text = { type: MessageBlockType.MAIN_TEXT, content: '你好', status: MessageBlockStatus.STREAMING }
      rerender(<StreamedReply content="你好" />)
      act(() => {
        vi.advanceTimersByTime(3_000)
      })
      expect(screen.queryByText('你')).not.toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent('模型正在输出')
      await act(async () => {
        frames.shift()?.(20)
        await Promise.resolve()
      })
      expect(screen.getByText('你')).toBeVisible()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(mocks.listeners.size).toBe(0)
      unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('handles invalid or future start timestamps without negative/NaN elapsed time', () => {
    expect(taskElapsedSeconds({ ...message, createdAt: 'invalid' }, Date.now())).toBe(0)
    expect(taskElapsedSeconds(message, Date.parse(message.createdAt) - 10_000)).toBe(0)
  })
})

describe('manual stopping is not an error or a successful completion', () => {
  it('shows a single compact neutral notice', () => {
    render(<AgentStoppedNotice />)
    expect(screen.getByRole('status')).toHaveTextContent('已停止')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText(/失败|未完成|重试|诊断/)).not.toBeInTheDocument()
  })
  it('recognizes persisted cancellation and old explicit pause markers, not timeouts', () => {
    const pause = { error: { i18nKey: ERROR_I18N_KEY_STREAM_PAUSED } } as ErrorMessageBlock
    expect(isUserStoppedMessage(message, pause)).toBe(true)
    expect(
      isUserStoppedMessage({ ...message, providerMetadata: { responseTiming: { outcome: 'cancelled' } as any } })
    ).toBe(true)
    expect(
      isUserStoppedMessage({ ...message, providerMetadata: { responseTiming: { outcome: 'failed' } as any } }, pause)
    ).toBe(false)
    expect(isUserStoppedMessage(message, { error: { name: 'TimeoutError' } } as ErrorMessageBlock)).toBe(false)
    expect(
      isUserStoppedMessage(message, { error: { name: 'AbortError', message: 'network failure' } } as ErrorMessageBlock)
    ).toBe(false)
  })
})
