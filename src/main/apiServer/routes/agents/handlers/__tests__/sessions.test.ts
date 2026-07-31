import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  broadcastSessionChanged: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn()
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
    getSession: (...args: unknown[]) => mocks.getSession(...args)
  }
}))

vi.mock('@main/services/agents/services/channels/sessionStreamIpc', () => ({
  broadcastSessionChanged: (...args: unknown[]) => mocks.broadcastSessionChanged(...args)
}))

import { createSession, deleteSession } from '../sessions'

describe('agent session handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
