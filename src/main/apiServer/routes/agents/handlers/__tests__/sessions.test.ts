import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  broadcastSessionChanged: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  sessionExists: vi.fn(),
  resetOpenCodeMemory: vi.fn(),
  changeOpenCodeHistory: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}))

vi.mock('@main/services/agents', () => ({
  AgentModelValidationError: class AgentModelValidationError extends Error {},
  agentService: {},
  sessionService: {
    createSession: (...args: unknown[]) => mocks.createSession(...args),
    deleteSession: (...args: unknown[]) => mocks.deleteSession(...args),
    getSession: (...args: unknown[]) => mocks.getSession(...args),
    sessionExists: mocks.sessionExists,
    resetOpenCodeMemory: mocks.resetOpenCodeMemory,
    changeOpenCodeHistory: mocks.changeOpenCodeHistory
  }
}))

vi.mock('@main/services/agents/services/channels/sessionStreamIpc', () => ({
  broadcastSessionChanged: (...args: unknown[]) => mocks.broadcastSessionChanged(...args)
}))

vi.mock('@main/services/agents/services/LegacyContinuationService', () => ({
  legacyContinuationService: { continueSession: vi.fn() }
}))

import { changeNativeHistory, createSession, deleteSession, resetNativeMemory } from '../sessions'

describe('agent session handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clears both native and persisted history for the new assistant', async () => {
    mocks.sessionExists.mockResolvedValue(true)
    mocks.resetOpenCodeMemory.mockResolvedValue(undefined)
    const req = { params: { agentId: 'zen-opencode-default', sessionId: 'session-1' } } as unknown as Request
    const send = vi.fn()
    const status = vi.fn(() => ({ send }))
    await resetNativeMemory(req, { status } as unknown as Response)
    expect(mocks.resetOpenCodeMemory).toHaveBeenCalledWith('zen-opencode-default', 'session-1')
    expect(status).toHaveBeenCalledWith(204)
  })

  it('rejects resets during an active task', async () => {
    mocks.sessionExists.mockResolvedValue(true)
    mocks.resetOpenCodeMemory.mockRejectedValue(new Error('Stop task first'))
    const req = { params: { agentId: 'zen-opencode-default', sessionId: 'session-1' } } as unknown as Request
    const json = vi.fn()
    const status = vi.fn(() => ({ json }))
    await resetNativeMemory(req, { status } as unknown as Response)
    expect(status).toHaveBeenCalledWith(409)
  })

  it.each(['retry', 'delete', 'fork'])('persists and broadcasts a native %s operation', async (action) => {
    mocks.sessionExists.mockResolvedValue(true)
    const session = { id: action === 'fork' ? 'branch-1' : 'session-1', agent_id: 'zen-opencode-default' }
    mocks.changeOpenCodeHistory.mockResolvedValue(session)
    const req = {
      params: { agentId: 'zen-opencode-default', sessionId: 'session-1' },
      body: { action, messageId: 'message-1' }
    } as unknown as Request
    const json = vi.fn()
    await changeNativeHistory(req, { json } as unknown as Response)
    expect(mocks.changeOpenCodeHistory).toHaveBeenCalledWith('zen-opencode-default', 'session-1', 'message-1', action)
    expect(mocks.broadcastSessionChanged).toHaveBeenCalledWith(
      'zen-opencode-default',
      session.id,
      false,
      action === 'fork' ? 'created' : 'completed'
    )
    expect(json).toHaveBeenCalledWith(session)
  })

  it.each([
    { action: 'edit', messageId: 'message-1' },
    { action: 'delete', messageId: '' },
    { action: 'retry', messageId: 42 },
    { action: 'fork', messageId: 'x'.repeat(257) }
  ])('rejects invalid native history input before changing history: %j', async (body) => {
    mocks.sessionExists.mockResolvedValue(true)
    const req = {
      params: { agentId: 'zen-opencode-default', sessionId: 'session-1' },
      body
    } as unknown as Request
    const json = vi.fn()
    const status = vi.fn(() => ({ json }))
    await changeNativeHistory(req, { status } as unknown as Response)
    expect(status).toHaveBeenCalledWith(400)
    expect(mocks.changeOpenCodeHistory).not.toHaveBeenCalled()
    expect(mocks.broadcastSessionChanged).not.toHaveBeenCalled()
  })

  it.each(['agent-legacy', 'zen-opencode-default'])(
    'rejects an unavailable new assistant session: %s',
    async (agentId) => {
      mocks.sessionExists.mockResolvedValue(false)
      const req = {
        params: { agentId, sessionId: 'session-1' },
        body: { action: 'delete', messageId: 'message-1' }
      } as unknown as Request
      const json = vi.fn()
      const status = vi.fn(() => ({ json }))
      await changeNativeHistory(req, { status } as unknown as Response)
      expect(status).toHaveBeenCalledWith(404)
      expect(mocks.changeOpenCodeHistory).not.toHaveBeenCalled()
    }
  )

  it('reports a history conflict without broadcasting or exposing internal error details', async () => {
    mocks.sessionExists.mockResolvedValue(true)
    mocks.changeOpenCodeHistory.mockRejectedValue(new Error('Stop active task; secret-internal-detail'))
    const req = {
      params: { agentId: 'zen-opencode-default', sessionId: 'session-1' },
      body: { action: 'retry', messageId: 'message-1' }
    } as unknown as Request
    const json = vi.fn()
    const status = vi.fn(() => ({ json }))
    await changeNativeHistory(req, { status } as unknown as Response)
    expect(status).toHaveBeenCalledWith(409)
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'native_history_change_failed',
        message: 'History was not changed; stop any active task and retry'
      }
    })
    expect(mocks.broadcastSessionChanged).not.toHaveBeenCalled()
  })

  it('broadcasts newly created sessions before returning them', async () => {
    const session = { id: 'session-1', agent_id: 'agent-1', name: 'Untitled' }
    mocks.createSession.mockResolvedValue(session)

    const req = {
      params: { agentId: 'agent-1' },
      body: { name: 'Untitled' }
    } as unknown as Request
    const json = vi.fn()
    const status = vi.fn(() => ({ json }))
    const res = { status } as unknown as Response

    await createSession(req, res)

    expect(mocks.createSession).toHaveBeenCalledWith('agent-1', { name: 'Untitled' })
    expect(mocks.broadcastSessionChanged).toHaveBeenCalledWith('agent-1', 'session-1', false, 'created')
    expect(status).toHaveBeenCalledWith(201)
    expect(json).toHaveBeenCalledWith(session)
  })

  it('allows the last session to be deleted without silently creating another empty session', async () => {
    mocks.getSession.mockResolvedValue({ id: 'session-1', agent_id: 'agent-1' })
    mocks.deleteSession.mockResolvedValue(true)

    const req = {
      params: { agentId: 'agent-1', sessionId: 'session-1' }
    } as unknown as Request
    const send = vi.fn()
    const status = vi.fn(() => ({ send }))
    const res = { status } as unknown as Response

    await deleteSession(req, res)

    expect(mocks.deleteSession).toHaveBeenCalledWith('agent-1', 'session-1')
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(204)
    expect(send).toHaveBeenCalled()
  })
})
