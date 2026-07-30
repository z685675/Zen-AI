import { act, renderHook } from '@testing-library/react'
import type * as ReactI18next from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agent: null as any,
  sessions: [] as any[],
  createSession: vi.fn(),
  dispatch: vi.fn(),
  fetchMessages: vi.fn(),
  getAgent: vi.fn(),
  setActiveSessionIdAction: vi.fn((payload) => ({ type: 'runtime/setActiveSessionId', payload })),
  updateSession: vi.fn()
}))

vi.mock('@renderer/hooks/agents/useAgent', () => ({
  useAgent: () => ({ agent: mocks.agent })
}))

vi.mock('@renderer/hooks/agents/useAgentClient', () => ({
  useAgentClient: () => ({ getAgent: mocks.getAgent })
}))

vi.mock('@renderer/hooks/agents/useSessions', () => ({
  useSessions: () => ({ sessions: mocks.sessions, createSession: mocks.createSession })
}))

vi.mock('@renderer/hooks/agents/useUpdateSession', () => ({
  useUpdateSession: () => ({ updateSession: mocks.updateSession })
}))

vi.mock('@renderer/services/db/DbService', () => ({
  DbService: {
    getInstance: () => ({ fetchMessages: mocks.fetchMessages })
  }
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch
}))

vi.mock('@renderer/store/runtime', () => ({
  setActiveSessionIdAction: (payload: unknown) => mocks.setActiveSessionIdAction(payload)
}))

vi.mock('@shared/config/agents', () => ({
  canCreateAgentSession: () => true
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({
    t: (key: string) => (key === 'common.unnamed' ? 'Unnamed' : key)
  })
}))

import { useCreateDefaultSession } from '../useCreateDefaultSession'

const makeAgent = (overrides: Record<string, unknown> = {}) => ({
  id: 'agent-1',
  type: 'claude-code',
  name: 'Official Assistant',
  model: 'provider:gpt-5.6-luna',
  accessible_paths: ['C:\\workspace'],
  created_at: '2026-07-21T00:00:00.000Z',
  updated_at: '2026-07-21T00:00:00.000Z',
  ...overrides
})

const makeSession = (overrides: Record<string, unknown> = {}) => ({
  ...makeAgent(),
  id: 'session-1',
  agent_id: 'agent-1',
  agent_type: 'claude-code',
  name: 'Unnamed',
  model: 'provider:claude-opus-4-6',
  ...overrides
})

describe('useCreateDefaultSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agent = makeAgent({ model: 'provider:claude-opus-4-6' })
    mocks.sessions = [makeSession()]
    mocks.fetchMessages.mockResolvedValue({ messages: [], blocks: [] })
    mocks.getAgent.mockResolvedValue(makeAgent())
    mocks.createSession.mockResolvedValue(null)
    mocks.updateSession.mockImplementation(async (form) => ({ ...mocks.sessions[0], ...form }))
  })

  it('aligns a reused empty session with the current new-conversation default model', async () => {
    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

    let session: any
    await act(async () => {
      session = await result.current.createDefaultSession()
    })

    expect(mocks.updateSession).toHaveBeenCalledWith(
      { id: 'session-1', model: 'provider:gpt-5.6-luna' },
      { showSuccessToast: false }
    )
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.getAgent).toHaveBeenCalledWith('agent-1')
    expect(session.model).toBe('provider:gpt-5.6-luna')
    expect(mocks.setActiveSessionIdAction).toHaveBeenCalledWith({ agentId: 'agent-1', sessionId: 'session-1' })
  })

  it('creates a fresh session from the agent default when the unnamed candidate already has messages', async () => {
    mocks.fetchMessages.mockResolvedValue({ messages: [{ id: 'message-1' }], blocks: [] })
    mocks.createSession.mockImplementation(async (form) => makeSession({ ...form, id: 'session-2' }))
    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

    await act(async () => {
      await result.current.createDefaultSession()
    })

    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'provider:gpt-5.6-luna' }))
    expect(mocks.setActiveSessionIdAction).toHaveBeenCalledWith({ agentId: 'agent-1', sessionId: 'session-2' })
  })
})
