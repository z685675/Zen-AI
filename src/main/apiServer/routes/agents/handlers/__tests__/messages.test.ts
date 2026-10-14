import {
  LEGACY_ASSISTANT_READ_ONLY_CODE,
  LEGACY_ASSISTANT_READ_ONLY_MESSAGE
} from '@shared/agents/assistantAvailability'
import { AgentTaskLimitError } from '@shared/agents/taskConcurrency'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { recordMainDiagnosticMock } = vi.hoisted(() => ({ recordMainDiagnosticMock: vi.fn() }))
vi.mock('@main/services/DiagnosticEvidenceService', () => ({ recordMainDiagnostic: recordMainDiagnosticMock }))
const { agentExistsMock, getSessionMock, createSessionMessageMock, deleteSessionMessageMock } = vi.hoisted(() => ({
  agentExistsMock: vi.fn(),
  getSessionMock: vi.fn(),
  createSessionMessageMock: vi.fn(),
  deleteSessionMessageMock: vi.fn()
}))
vi.mock('@main/services/agents', () => ({
  agentService: { agentExists: agentExistsMock },
  sessionService: { getSession: getSessionMock },
  sessionMessageService: {
    createSessionMessage: createSessionMessageMock,
    deleteSessionMessage: deleteSessionMessageMock
  }
}))

import { createMessage, deleteMessage } from '../messages'

describe('local agent API diagnostic boundary', () => {
  beforeEach(() => {
    agentExistsMock.mockReset().mockResolvedValue(false)
    getSessionMock.mockReset()
    createSessionMessageMock.mockReset()
    deleteSessionMessageMock.mockReset().mockResolvedValue(true)
    recordMainDiagnosticMock.mockClear()
  })

  it.each([DEFAULT_OPENCODE_AGENT_ID, 'legacy-agent'])('routes display deletion safely for %s', async (agentId) => {
    agentExistsMock.mockResolvedValue(true)
    getSessionMock.mockResolvedValue({ id: 'session', agent_id: agentId })
    const res = { status: vi.fn(), json: vi.fn(), send: vi.fn() } as any
    res.status.mockReturnValue(res)
    await deleteMessage({ params: { agentId, sessionId: 'session', messageId: '1' } } as any, res)
    if (agentId === DEFAULT_OPENCODE_AGENT_ID) {
      expect(res.status).toHaveBeenCalledWith(409)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ code: 'native_history_required' }) })
      )
      expect(deleteSessionMessageMock).not.toHaveBeenCalled()
    } else {
      expect(deleteSessionMessageMock).toHaveBeenCalledExactlyOnceWith('session', 1)
      expect(res.status).toHaveBeenCalledWith(204)
    }
  })

  it.each([1, 3])('preserves the %i-task capacity notice in the SSE error', async (limit) => {
    agentExistsMock.mockResolvedValue(true)
    getSessionMock.mockResolvedValue({ id: 'session', agent_id: DEFAULT_OPENCODE_AGENT_ID })
    createSessionMessageMock.mockRejectedValue(new AgentTaskLimitError(limit, limit))
    const req = {
      params: { agentId: DEFAULT_OPENCODE_AGENT_ID, sessionId: 'session' },
      body: { content: 'hello' },
      get: () => 'capacity-test'
    } as unknown as Request
    const write = vi.fn()
    const end = vi.fn()
    await createMessage(req, { setHeader: vi.fn(), write, end } as unknown as Response)
    const event = JSON.parse(write.mock.calls[0][0].replace(/^data: /, '').trim())
    expect(event.error).toMatchObject({
      name: 'AgentTaskLimitError',
      code: 'agent_task_limit',
      type: 'task_limit',
      zenTaskLimit: { limit, activeTasks: limit },
      zenFailureStage: 'local-task-admission'
    })
    expect(recordMainDiagnosticMock).toHaveBeenCalledWith('capacity-test', 'preparation', 'blocked', {
      phase: 'local-task-admission',
      limit,
      activeTasks: limit
    })
    expect(end).toHaveBeenCalledOnce()
  })

  it('records pre-runtime validation failures while retaining the existing SSE error', async () => {
    const req = {
      params: { agentId: 'missing-agent', sessionId: 'missing-session' },
      get: () => 'zen-diag-local-validation'
    } as unknown as Request
    const write = vi.fn()
    const end = vi.fn()
    const res = { setHeader: vi.fn(), write, end } as unknown as Response
    await createMessage(req, res)
    expect(recordMainDiagnosticMock).toHaveBeenCalledWith(
      'zen-diag-local-validation',
      'preparation',
      'failed',
      expect.objectContaining({ phase: 'local-api-session-validation' })
    )
    expect(write).toHaveBeenCalledWith(expect.stringContaining('agent_not_found'))
    expect(end).toHaveBeenCalledOnce()
  })

  it('returns a read-only 410 for old sessions without starting SSE or reporting a model failure', async () => {
    agentExistsMock.mockResolvedValue(true)
    getSessionMock.mockResolvedValue({ id: 'session', agent_id: 'legacy-agent' })
    const json = vi.fn()
    const status = vi.fn(() => ({ json }))
    const setHeader = vi.fn()
    const write = vi.fn()
    await createMessage(
      {
        params: { agentId: 'legacy-agent', sessionId: 'session' },
        body: { content: 'hello' },
        get: () => 'read-only-test'
      } as unknown as Request,
      { status, setHeader, write } as unknown as Response
    )
    expect(status).toHaveBeenCalledWith(410)
    expect(json).toHaveBeenCalledWith({
      error: {
        code: LEGACY_ASSISTANT_READ_ONLY_CODE,
        type: 'read_only',
        message: LEGACY_ASSISTANT_READ_ONLY_MESSAGE
      }
    })
    expect(setHeader).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(createSessionMessageMock).not.toHaveBeenCalled()
    expect(recordMainDiagnosticMock).not.toHaveBeenCalled()
  })
})
