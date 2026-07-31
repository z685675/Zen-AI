import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activeAgentId: 'agent-1' as string | null,
  activeSessionIdMap: {} as Record<string, string | null>,
  dispatch: vi.fn(),
  listSessions: vi.fn()
}))

vi.mock('@renderer/hooks/useRuntime', () => ({
  useRuntime: () => ({
    chat: {
      activeAgentId: mocks.activeAgentId,
      activeSessionIdMap: mocks.activeSessionIdMap
    }
  })
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch
}))

vi.mock('@renderer/store/runtime', () => ({
  setActiveSessionIdAction: (payload: { agentId: string; sessionId: string | null }) => ({
    type: 'runtime/setActiveSessionIdAction',
    payload
  })
}))

vi.mock('../useAgentClient', () => ({
  useAgentClient: () => ({
    listSessions: mocks.listSessions
  })
}))

import { useAgentSessionInitializer } from '../useAgentSessionInitializer'

describe('useAgentSessionInitializer', () => {
  beforeEach(() => {
    mocks.activeAgentId = 'agent-1'
    mocks.activeSessionIdMap = {}
    mocks.dispatch.mockReset()
    mocks.listSessions.mockReset()
  })

  it('restores the top session when the stored active session is null', async () => {
    mocks.activeSessionIdMap = { 'agent-1': null }
    mocks.listSessions.mockResolvedValue({
      data: [{ id: 'session-top' }],
      total: 1,
      limit: 20,
      offset: 0
    })

    renderHook(() => useAgentSessionInitializer())

    await waitFor(() => {
      expect(mocks.dispatch).toHaveBeenCalledWith({
        type: 'runtime/setActiveSessionIdAction',
        payload: { agentId: 'agent-1', sessionId: 'session-top' }
      })
    })
  })

  it('keeps an existing active session without querying again', async () => {
    mocks.activeSessionIdMap = { 'agent-1': 'session-current' }

    renderHook(() => useAgentSessionInitializer())

    await waitFor(() => {
      expect(mocks.listSessions).not.toHaveBeenCalled()
      expect(mocks.dispatch).not.toHaveBeenCalled()
    })
  })
})
