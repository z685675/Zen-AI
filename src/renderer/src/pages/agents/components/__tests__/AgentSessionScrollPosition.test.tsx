import type { Message } from '@renderer/types/newMessage'
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  messages: [] as Message[],
  dispatch: vi.fn(),
  setup: vi.fn(),
  user: vi.fn(() => 'run:user'),
  load: vi.fn()
}))
vi.mock('@renderer/hooks/agents/useAgent', () => ({
  useAgent: () => ({ agent: { id: 'agent', model: { id: 'test' } } })
}))
vi.mock('@renderer/hooks/agents/useSession', () => ({
  useSession: () => ({ session: { id: 'one', agent_id: 'agent', model: 'local:test' } })
}))
vi.mock('@renderer/hooks/useMessageOperations', () => ({ useTopicMessages: () => mocks.messages }))
vi.mock('@renderer/hooks/useModel', () => ({ getModel: () => ({ id: 'test' }) }))
vi.mock('@renderer/hooks/useSettings', () => ({ useSettings: () => ({ messageNavigation: 'none' }) }))
vi.mock('@renderer/store', () => ({ default: { getState: vi.fn() }, useAppDispatch: () => mocks.dispatch }))
vi.mock('@renderer/store/thunk/messageThunk', () => ({
  setupChannelStream: mocks.setup,
  addChannelUserMessage: mocks.user,
  loadTopicMessagesThunk: mocks.load
}))
vi.mock('@renderer/services/MessagesService', () => ({
  getGroupedMessages: (messages: Message[]) => Object.fromEntries(messages.map((message) => [message.id, [message]]))
}))
vi.mock('@renderer/pages/home/Messages/MessageGroup', () => ({
  default: ({ messages }: { messages: Message[] }) => (
    <div>
      {messages.map((message) => (
        <div data-message={message.id} key={message.id}>
          {message.id}
        </div>
      ))}
    </div>
  )
}))
vi.mock('@renderer/pages/home/Messages/MessageAnchorLine', () => ({ default: () => null }))
vi.mock('@renderer/pages/home/Messages/NarrowLayout', () => ({ default: ({ children }: any) => <div>{children}</div> }))
vi.mock('@renderer/components/ContextMenu', () => ({ default: ({ children }: any) => <div>{children}</div> }))
vi.mock('react-infinite-scroll-component', () => ({
  default: ({ children, next, hasMore }: any) => (
    <div>
      <button type="button" onClick={() => next()} disabled={!hasMore}>
        Older messages
      </button>
      {children}
    </div>
  )
}))

import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'

import AgentSessionMessages from '../AgentSessionMessages'

let positions: Map<string, number>
const key = (id: string) => `scroll:agent-session-${id}`
const frames = async (count = 12) => {
  for (let i = 0; i < count; i++) await act(async () => vi.advanceTimersToNextFrame())
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  positions = new Map()
  mocks.messages = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 ? 'assistant' : 'user',
    blocks: [],
    createdAt: '2026-10-25',
    status: 'success'
  })) as Message[]
  Object.assign(window, {
    keyv: {
      get: (id: string) => positions.get(id),
      set: vi.fn((id: string, value: number) => positions.set(id, value))
    },
    api: {
      agentSessionStream: {
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        onChunk: vi.fn(() => vi.fn())
      }
    }
  })
  // Simulate the negative scroll range of the real column-reverse message list.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: function (this: HTMLElement, { top }: ScrollToOptions) {
      const extent = Math.max(0, this.querySelectorAll('[data-message]').length * 100 - 100)
      this.scrollTop = Math.max(-extent, Math.min(0, top ?? 0))
      fireEvent.scroll(this)
    }
  })
})
afterEach(() => vi.useRealTimers())

describe('assistant reading position across navigation', () => {
  it('renders canonical channel IDs without persistence and reloads only after the stream drains', async () => {
    let drain!: () => void
    const ctrl = {
      assistantMessageId: 'run:assistant',
      markUserMessageReceived: vi.fn(),
      pushChunk: vi.fn(),
      complete: vi.fn(),
      settled: new Promise<void>((resolve) => {
        drain = resolve
      })
    }
    mocks.setup.mockReturnValue(ctrl)
    render(<AgentSessionMessages agentId="agent" sessionId="one" />)
    await act(async () => {})
    const receive = vi.mocked(window.api.agentSessionStream.onChunk).mock.calls[0][0]
    const base = {
      sessionId: 'one',
      agentId: 'agent',
      persistence: { userMessageId: 'run:user', assistantMessageId: 'run:assistant' }
    }
    await act(async () => receive({ ...base, type: 'user-message', userMessage: { text: '你好' } } as any))
    expect(mocks.user.mock.calls[0].at(-1)).toEqual({ messageId: 'run:user', persist: false })
    expect(mocks.setup.mock.calls[0].slice(-2)).toEqual(['run:user', { messageId: 'run:assistant', persist: false }])
    await act(async () => receive({ ...base, type: 'chunk', chunk: { type: 'text-delta', text: 'answer' } } as any))
    await act(async () => receive({ ...base, type: 'complete' }))
    expect(mocks.load).not.toHaveBeenCalled()
    await act(async () => {
      drain()
      await ctrl.settled
    })
    expect(mocks.load).toHaveBeenCalledWith('agent-session:one', true)
    await act(async () => receive({ ...base, type: 'chunk', chunk: { type: 'text-delta', text: 'late' } } as any))
    expect(mocks.setup).toHaveBeenCalledOnce()
    expect(ctrl.pushChunk).toHaveBeenCalledOnce()
    const next = { ...base, persistence: { userMessageId: 'next:user', assistantMessageId: 'next:assistant' } }
    // Joining a new exchange after missing its user event must also use canonical IDs.
    await act(async () => receive({ ...next, type: 'chunk', chunk: { type: 'text-delta', text: 'next' } } as any))
    expect(mocks.setup).toHaveBeenCalledTimes(2)
    await act(async () => receive({ ...base, type: 'chunk', chunk: { type: 'text-delta', text: 'old' } } as any))
    expect(mocks.setup).toHaveBeenCalledTimes(2)
  })

  it('loads older pages before restoring a deep position without overwriting it with a clipped position', async () => {
    positions.set(key('one'), -1200)
    const { container } = render(<AgentSessionMessages agentId="agent" sessionId="one" />)
    expect(container.querySelectorAll('[data-message]')).toHaveLength(5)
    await frames()
    expect(container.querySelector('#messages')!.scrollTop).toBe(-1200)
    expect(container.querySelectorAll('[data-message]').length).toBeGreaterThan(5)
    expect(positions.get(key('one'))).toBe(-1200)
    expect(window.keyv.set).not.toHaveBeenCalled()
  })

  it('returns to each conversation at its own last position, including a rapid switch', async () => {
    positions.set(key('one'), -1200)
    const view = render(<AgentSessionMessages key="one" agentId="agent" sessionId="one" />)
    await frames()
    let node = view.container.querySelector('#messages')!
    node.scrollTop = -1100
    fireEvent.scroll(node)
    node.scrollTop = -731
    fireEvent.scroll(node)
    view.rerender(<AgentSessionMessages key="two" agentId="agent" sessionId="two" />)
    await frames(2)
    node = view.container.querySelector('#messages')!
    expect(node.scrollTop).toBe(0)
    node.scrollTop = -200
    fireEvent.scroll(node)
    view.rerender(<AgentSessionMessages key="one" agentId="agent" sessionId="one" />)
    await frames()
    expect(view.container.querySelector('#messages')!.scrollTop).toBe(-731)
    expect(positions.get(key('two'))).toBe(-200)
    view.unmount()
    const returned = render(<AgentSessionMessages agentId="agent" sessionId="one" />)
    await frames()
    expect(returned.container.querySelector('#messages')!.scrollTop).toBe(-731)
  })

  it('does not jump to the bottom when paging or receiving message updates after restoration', async () => {
    const view = render(<AgentSessionMessages agentId="agent" sessionId="one" />)
    await frames(2)
    const node = view.container.querySelector('#messages')!
    node.scrollTop = -300
    fireEvent.scroll(node)
    fireEvent.click(view.getByText('Older messages'))
    await frames()
    expect(node.scrollTop).toBe(-300)
    mocks.messages = [...mocks.messages, { ...mocks.messages[19], id: 'new-reply' }]
    view.rerender(<AgentSessionMessages agentId="agent" sessionId="one" />)
    await frames()
    expect(node.scrollTop).toBe(-300)
  })

  it('lets the user interrupt restoration and still scrolls down when they send in this conversation', async () => {
    positions.set(key('one'), -1200)
    const view = render(<AgentSessionMessages agentId="agent" sessionId="one" />)
    const node = view.container.querySelector('#messages')!
    fireEvent.wheel(node)
    node.scrollTop = -200
    fireEvent.scroll(node)
    await frames()
    expect(node.scrollTop).toBe(-200)
    await act(async () => EventEmitter.emit(EVENT_NAMES.SEND_MESSAGE, { topicId: 'agent-session:other' }))
    await frames(2)
    expect(node.scrollTop).toBe(-200)
    await act(async () => EventEmitter.emit(EVENT_NAMES.SEND_MESSAGE, { topicId: 'agent-session:one' }))
    await frames(2)
    expect(node.scrollTop).toBe(0)
  })
})
