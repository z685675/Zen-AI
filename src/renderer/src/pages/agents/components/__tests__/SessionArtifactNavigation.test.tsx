import type { Message } from '@renderer/types/newMessage'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ messages: [] as Message[], dispatch: vi.fn() }))
vi.mock('@renderer/hooks/agents/useAgent', () => ({
  useAgent: () => ({ agent: { id: 'agent', model: { id: 'test' } } })
}))
vi.mock('@renderer/hooks/agents/useSession', () => ({
  useSession: () => ({ session: { id: 'one', agent_id: 'agent', name: 'test', model: 'local:test' } })
}))
vi.mock('@renderer/hooks/useMessageOperations', () => ({ useTopicMessages: () => mocks.messages }))
vi.mock('@renderer/hooks/useModel', () => ({ getModel: () => ({ id: 'test' }) }))
vi.mock('@renderer/hooks/useSettings', () => ({ useSettings: () => ({ messageNavigation: 'none' }) }))
vi.mock('@renderer/hooks/useScrollPosition', () => ({
  default: () => ({
    containerRef: { current: null },
    handleScroll: vi.fn(),
    getStoredPosition: () => null,
    restorePosition: vi.fn()
  })
}))
vi.mock('@renderer/store', () => ({ default: { getState: vi.fn() }, useAppDispatch: () => mocks.dispatch }))
vi.mock('@renderer/store/thunk/messageThunk', () => ({ setupChannelStream: vi.fn(), addChannelUserMessage: vi.fn() }))
vi.mock('@renderer/services/MessagesService', () => ({
  getGroupedMessages: (messages: Message[]) => Object.fromEntries(messages.map((message) => [message.id, [message]]))
}))
vi.mock('@renderer/pages/home/Messages/MessageGroup', () => ({
  default: ({ messages }: { messages: Message[] }) => (
    <div>
      {messages.map((message) => (
        <span key={message.id}>{message.id}</span>
      ))}
    </div>
  )
}))
vi.mock('@renderer/pages/home/Messages/MessageAnchorLine', () => ({ default: () => null }))
vi.mock('@renderer/pages/home/Messages/NarrowLayout', () => ({ default: ({ children }: any) => <div>{children}</div> }))
vi.mock('@renderer/components/ContextMenu', () => ({ default: ({ children }: any) => <div>{children}</div> }))
vi.mock('react-infinite-scroll-component', () => ({ default: ({ children }: any) => <div>{children}</div> }))

import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'

import AgentSessionMessages from '../AgentSessionMessages'

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  mocks.messages = Array.from({ length: 10 }, (_, index) => [
    { id: `u${index}`, role: 'user', blocks: [], createdAt: '2026-10-12', status: 'success' },
    { id: `a${index}`, role: 'assistant', askId: `u${index}`, blocks: [], createdAt: '2026-10-12', status: 'success' }
  ]).flat() as Message[]
  Object.assign(window, {
    api: {
      agentSessionStream: {
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        onChunk: vi.fn(() => vi.fn())
      }
    }
  })
})

describe('output origin navigation through paginated history', () => {
  it('reveals an old source, selects its reply, emits locate after mounting and keeps it on block/state updates', async () => {
    const spy = vi.spyOn(EventEmitter, 'emit')
    const { rerender } = render(<AgentSessionMessages agentId="agent" sessionId="one" />)
    expect(screen.queryByText('a1')).not.toBeInTheDocument()
    await act(async () => {
      await EventEmitter.emit(EVENT_NAMES.LOCATE_MESSAGE, { topicId: 'agent-session:one', messageId: 'a1' })
    })
    await waitFor(() => expect(screen.getByText('a1')).toBeVisible())
    await waitFor(() => expect(spy).toHaveBeenCalledWith('LOCATE_MESSAGE:a1'))
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ messageId: 'a1', updates: { foldSelected: true } })
      })
    )
    mocks.messages = mocks.messages.map((message) => ({ ...message }))
    rerender(<AgentSessionMessages agentId="agent" sessionId="one" />)
    expect(screen.getByText('a1')).toBeVisible()
    spy.mockRestore()
  })
  it('ignores other conversations and removed sources without changing the rendered page', async () => {
    render(<AgentSessionMessages agentId="agent" sessionId="one" />)
    await act(async () => {
      await EventEmitter.emit(EVENT_NAMES.LOCATE_MESSAGE, { topicId: 'agent-session:two', messageId: 'a1' })
      await EventEmitter.emit(EVENT_NAMES.LOCATE_MESSAGE, { topicId: 'agent-session:one', messageId: 'removed' })
    })
    expect(screen.queryByText('a1')).not.toBeInTheDocument()
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
})
