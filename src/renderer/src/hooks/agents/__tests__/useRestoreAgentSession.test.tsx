import { AgentWorkspaceContext } from '@renderer/context/AgentWorkspaceProvider'
import { CacheService } from '@renderer/services/CacheService'
import type { GetAgentResponse } from '@renderer/types'
import { saveAgentSessionDraft } from '@renderer/utils/agentSessionDraft'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  chat: { activeAgentId: 'agent' as string | null, activeSessionIdMap: {} as Record<string, string | null> },
  client: { listAllSessions: vi.fn() },
  dispatch: vi.fn(),
  fetchMessages: vi.fn()
}))
vi.mock('../useAgentClient', () => ({ useAgentClient: () => mocks.client }))
vi.mock('@renderer/services/db/DbService', () => ({
  DbService: { getInstance: () => ({ fetchMessages: mocks.fetchMessages }) }
}))
vi.mock('@renderer/store', () => ({
  default: { getState: () => ({ runtime: { chat: mocks.chat }, messages: { loadingByTopic: {} } }) },
  useAppDispatch: () => mocks.dispatch
}))
vi.mock('@renderer/store/newMessage', () => ({ selectMessagesForTopic: () => [] }))

import { useRestoreAgentSession } from '../useRestoreAgentSession'

const agents = [{ id: 'agent' }] as GetAgentResponse[]
const wrapper = ({ children }: React.PropsWithChildren) => (
  <AgentWorkspaceContext value="opencode">{children}</AgentWorkspaceContext>
)

beforeEach(() => {
  vi.clearAllMocks()
  CacheService.clear()
  localStorage.clear()
  mocks.chat = { activeAgentId: 'agent', activeSessionIdMap: {} }
  mocks.client.listAllSessions.mockResolvedValue({ data: [{ agent_id: 'agent', id: 'recent', name: 'Recent task' }] })
  mocks.fetchMessages.mockResolvedValue({ messages: [] })
})

describe('assistant page entry', () => {
  it('keeps the conversation being read when returning to the page', () => {
    mocks.chat.activeSessionIdMap.agent = 'older-conversation'
    const first = renderHook(() => useRestoreAgentSession(agents, true), { wrapper })
    first.unmount()
    renderHook(() => useRestoreAgentSession(agents, true), { wrapper })
    expect(mocks.client.listAllSessions).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('keeps a new draft-only conversation after returning', () => {
    mocks.chat.activeSessionIdMap.agent = 'draft'
    saveAgentSessionDraft('agent', 'draft', '未发送的输入')
    CacheService.clear()
    renderHook(() => useRestoreAgentSession(agents, true), { wrapper })
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(mocks.client.listAllSessions).not.toHaveBeenCalled()
  })

  it('restores a saved draft on first entry even though it has no messages', async () => {
    saveAgentSessionDraft('agent', 'draft', '未发送的输入')
    CacheService.clear()
    mocks.client.listAllSessions.mockResolvedValue({ data: [{ agent_id: 'agent', id: 'draft', name: 'Unnamed' }] })
    renderHook(() => useRestoreAgentSession(agents, true), { wrapper })
    await waitFor(() =>
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { agentId: 'agent', sessionId: 'draft' }
        })
      )
    )
    expect(mocks.fetchMessages).not.toHaveBeenCalled()
  })

  it('does not overwrite a selection made while the entry request was pending', async () => {
    let resolve!: (value: unknown) => void
    mocks.client.listAllSessions.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    renderHook(() => useRestoreAgentSession(agents, true), { wrapper })
    await act(async () => {
      mocks.chat.activeSessionIdMap.agent = 'user-selected'
      resolve({ data: [{ agent_id: 'agent', id: 'recent', name: 'Recent task' }] })
    })
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch a late database result after leaving the page', async () => {
    let resolve!: (value: unknown) => void
    mocks.client.listAllSessions.mockResolvedValue({ data: [{ agent_id: 'agent', id: 'empty', name: 'Unnamed' }] })
    mocks.fetchMessages.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const { unmount } = renderHook(() => useRestoreAgentSession(agents, true), { wrapper })
    await waitFor(() => expect(mocks.fetchMessages).toHaveBeenCalled())
    unmount()
    await act(async () => resolve({ messages: [{ id: 'message' }] }))
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
})
