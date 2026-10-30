import { AssistantMessageStatus, type Message } from '@renderer/types/newMessage'
import type { AutomationOverview } from '@shared/agents/automation'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  swr: vi.fn(),
  api: vi.fn(),
  state: { messages: { messageIdsByTopic: {}, entities: {} } } as any
}))
vi.mock('swr', () => ({ default: mocks.swr }))
vi.mock('@renderer/store', () => ({ useAppSelector: (select: (state: any) => unknown) => select(mocks.state) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

import AgentMessageSyncStatus from '../AgentMessageSyncStatus'

const topicId = 'agent-session:wechat-session'
const reply = (origin: 'desktop' | 'wechat' = 'wechat'): Message =>
  ({
    id: 'reply',
    role: 'assistant',
    topicId,
    assistantId: DEFAULT_OPENCODE_AGENT_ID,
    status: AssistantMessageStatus.SUCCESS,
    providerMetadata:
      origin === 'wechat'
        ? { zenAutomation: { persistenceId: 'turn' } }
        : { agentSessionSync: { target: 'wechat', status: 'synced', runId: 'turn' } }
  }) as Message

const overview = (): AutomationOverview => ({
  connection: { status: 'connected', enabled: true, sessionId: 'wechat-session' },
  syncedRuns: [{ id: 'turn', sessionId: 'wechat-session' }],
  deliveries: [],
  tasks: [],
  runs: [],
  sessions: [],
  legacyTasks: []
})

const setLatest = (message: Message) => {
  mocks.state = { messages: { messageIdsByTopic: { [topicId]: [message.id] }, entities: { [message.id]: message } } }
}

beforeEach(() => {
  vi.clearAllMocks()
  setLatest(reply())
  mocks.swr.mockReturnValue({ data: overview() })
  window.api.assistantAutomation = mocks.api
})

describe('last WeChat answer delivery badge', () => {
  it.each(['wechat', 'desktop'] as const)('shows a faint completion only for an acknowledged %s turn', (origin) => {
    render(<AgentMessageSyncStatus message={reply(origin)} processing={false} />)
    expect(screen.getByRole('status')).toHaveTextContent('automation.syncComplete')
    expect(screen.queryByText('automation.syncing')).not.toBeInTheDocument()
    const [key, , options] = mocks.swr.mock.calls[0]
    expect(key).toBe('assistant-automation-status')
    expect(options.refreshInterval(overview())).toBe(10_000)
    expect(options.refreshInterval({ ...overview(), syncedRuns: [] })).toBe(2000)
  })

  it('uses read-only actual delivery status, never a send or another model request', async () => {
    render(<AgentMessageSyncStatus message={reply()} processing={false} />)
    const fetcher = mocks.swr.mock.calls[0][1]
    mocks.api.mockResolvedValueOnce({ ok: true, data: overview() }).mockResolvedValueOnce({ ok: false })
    expect(await fetcher()).toEqual(overview())
    expect(await fetcher()).toBeNull()
    expect(mocks.api.mock.calls).toEqual([[{ action: 'status' }], [{ action: 'status' }]])
  })

  it('does not mistake a queued desktop mirror for completed delivery', () => {
    mocks.swr.mockReturnValue({ data: { ...overview(), syncedRuns: [] } })
    render(<AgentMessageSyncStatus message={reply('desktop')} processing={false} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('appears when acknowledgement arrives and disappears from the old answer on the next turn', () => {
    mocks.swr.mockReturnValue({ data: { ...overview(), syncedRuns: [] } })
    const { rerender } = render(<AgentMessageSyncStatus message={reply()} processing={false} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    mocks.swr.mockReturnValue({ data: overview() })
    rerender(<AgentMessageSyncStatus message={reply()} processing={false} />)
    expect(screen.getByRole('status')).toHaveTextContent('automation.syncComplete')
    mocks.state.messages.messageIdsByTopic[topicId].push('next-reply')
    mocks.state.messages.entities['next-reply'] = { ...reply(), id: 'next-reply', status: 'processing' }
    rerender(<AgentMessageSyncStatus message={reply()} processing={false} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it.each([
    { ...overview(), syncedRuns: undefined },
    { ...overview(), syncedRuns: [{ id: 'other-turn', sessionId: 'wechat-session' }] },
    { ...overview(), syncedRuns: [{ id: 'turn', sessionId: 'another-session' }] },
    { ...overview(), connection: { enabled: false, status: 'disconnected', sessionId: 'wechat-session' } },
    { ...overview(), connection: { enabled: true, status: 'connected', sessionId: 'another-session' } }
  ])('hides incomplete, unrelated or disabled synchronization %#', (data) => {
    mocks.swr.mockReturnValue({ data })
    render(<AgentMessageSyncStatus message={reply()} processing={false} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it.each(['processing', 'error', 'paused', 'ordinary', 'user', 'missing-turn', 'older'])(
    'does not poll or show a badge for %s messages',
    (kind) => {
      const message = reply()
      if (kind === 'error') message.status = AssistantMessageStatus.ERROR
      if (kind === 'paused') message.status = AssistantMessageStatus.PAUSED
      if (kind === 'ordinary') message.assistantId = 'another-assistant'
      if (kind === 'user') message.role = 'user'
      if (kind === 'missing-turn') message.providerMetadata = {}
      setLatest(message)
      if (kind === 'older') {
        mocks.state.messages.messageIdsByTopic[topicId].push('new-reply')
        mocks.state.messages.entities['new-reply'] = { ...message, id: 'new-reply' }
      }
      render(<AgentMessageSyncStatus message={message} processing={kind === 'processing'} />)
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(mocks.swr.mock.calls[0][0]).toBeNull()
    }
  )

  it('does not show cached success if the status check fails', () => {
    mocks.swr.mockReturnValue({ data: overview(), error: new Error('IPC unavailable') })
    render(<AgentMessageSyncStatus message={reply()} processing={false} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
