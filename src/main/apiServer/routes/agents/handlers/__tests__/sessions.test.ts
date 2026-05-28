import { agentService, sessionService } from '@main/services/agents'
import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteSession } from '../sessions'

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
  agentService: {
    agentExists: vi.fn()
  },
  sessionService: {
    getSession: vi.fn(),
    deleteSession: vi.fn(),
    listSessions: vi.fn(),
    createSession: vi.fn()
  }
}))

const createResponse = () => {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    send: vi.fn()
  } as unknown as Response

  vi.mocked(res.status).mockReturnValue(res)
  vi.mocked(res.json).mockReturnValue(res)
  vi.mocked(res.send).mockReturnValue(res)

  return res
}

describe('agent session handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deletes an orphan session without recreating a default session for a deleted agent', async () => {
    vi.mocked(sessionService.getSession).mockResolvedValueOnce({
      id: 'session-old',
      agent_id: 'deleted-agent',
      agent_type: 'claude-code'
    } as any)
    vi.mocked(sessionService.deleteSession).mockResolvedValueOnce(true)
    vi.mocked(agentService.agentExists).mockResolvedValueOnce(false)

    const req = {
      params: {
        agentId: 'deleted-agent',
        sessionId: 'session-old'
      }
    } as unknown as Request
    const res = createResponse()

    await deleteSession(req, res)

    expect(sessionService.deleteSession).toHaveBeenCalledWith('deleted-agent', 'session-old')
    expect(agentService.agentExists).toHaveBeenCalledWith('deleted-agent')
    expect(sessionService.listSessions).not.toHaveBeenCalled()
    expect(sessionService.createSession).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(204)
    expect(res.send).toHaveBeenCalled()
  })
})
