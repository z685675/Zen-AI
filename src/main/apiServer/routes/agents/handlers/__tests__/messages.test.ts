import {
  LEGACY_ASSISTANT_READ_ONLY_CODE,
  LEGACY_ASSISTANT_READ_ONLY_MESSAGE
} from '@shared/agents/assistantAvailability'
import { AgentTaskLimitError } from '@shared/agents/taskConcurrency'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  afterEach(() => vi.useRealTimers())

  function sseHarness() {
    agentExistsMock.mockResolvedValue(true)
    getSessionMock.mockResolvedValue({ id: 'session', agent_id: DEFAULT_OPENCODE_AGENT_ID })
    const req = Object.assign(new EventEmitter(), {
      params: { agentId: DEFAULT_OPENCODE_AGENT_ID, sessionId: 'session' },
      body: { content: 'hello' },
      get: () => 'stream-test'
    })
    const res = Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn() })
    return { req: req as unknown as Request, res: res as unknown as Response, write: res.write, end: res.end }
  }

  it.each(['startup', 'reader', 'completion'])(
    'preserves sanitized native errors from %s and never sends a success sentinel',
    async (phase) => {
      const { req, res, write, end } = sseHarness()
      const failure = Object.assign(new Error('socket closed Bearer fixture-secret'), {
        name: 'ProviderHeaderTimeoutError',
        code: 'ECONNRESET',
        cause: { message: 'headers timed out after 60000ms', authorization: 'fixture-secret' },
        zenFailureStage: 'provider-stream',
        zenTraceId: 'trace-safe'
      })
      if (phase === 'startup') createSessionMessageMock.mockRejectedValue(failure)
      else
        createSessionMessageMock.mockResolvedValue({
          stream: new ReadableStream({
            start(controller) {
              if (phase === 'reader') controller.error(failure)
              else controller.close()
            }
          }),
          completion: phase === 'completion' ? Promise.reject(failure) : Promise.resolve({})
        })
      await createMessage(req, res)
      await vi.waitFor(() => expect(end).toHaveBeenCalledOnce())
      expect(write).toHaveBeenCalledOnce()
      const event = JSON.parse(write.mock.calls[0][0].replace(/^data: /, '').trim())
      expect(event).toMatchObject({
        type: 'error',
        error: {
          name: 'ProviderHeaderTimeoutError',
          code: 'ECONNRESET',
          zenTraceId: 'trace-safe',
          zenFailureStage: 'provider-stream',
          cause: { message: 'headers timed out after 60000ms' }
        }
      })
      expect(write.mock.calls[0][0]).not.toContain('fixture-secret')
      expect(write.mock.calls[0][0]).not.toContain('[DONE]')
    }
  )

  it('sends only one failure when the stream and completion both reject', async () => {
    const { req, res, write, end } = sseHarness()
    const failure = new Error('socket closed')
    createSessionMessageMock.mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.error(failure)
        }
      }),
      completion: Promise.reject(failure)
    })
    await createMessage(req, res)
    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce())
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0][0]).toContain('socket closed')
  })

  it('waits for completion before sending DONE after a successful stream', async () => {
    const { req, res, write, end } = sseHarness()
    let complete!: (value: object) => void
    createSessionMessageMock.mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'finish', finishReason: 'stop' })
          controller.close()
        }
      }),
      completion: new Promise((resolve) => {
        complete = resolve
      })
    })
    await createMessage(req, res)
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    expect(end).not.toHaveBeenCalled()
    expect(write.mock.calls[0][0]).not.toContain('[DONE]')
    complete({})
    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce())
    expect(write.mock.calls.at(-1)![0]).toBe('data: [DONE]\n\n')
  })

  it('reports HTTP safety timeout as failure and cancels the runtime reader', async () => {
    vi.useFakeTimers()
    const { req, res, write, end } = sseHarness()
    const cancel = vi.fn()
    createSessionMessageMock.mockResolvedValue({
      stream: new ReadableStream({ cancel }),
      completion: new Promise(() => {})
    })
    await createMessage(req, res)
    await vi.runOnlyPendingTimersAsync()
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0][0]).toContain('stream_timeout')
    expect(cancel).toHaveBeenCalledOnce()
    expect(end).toHaveBeenCalledOnce()
  })

  it('cancels a disconnected client without fabricating a provider failure', async () => {
    const { req, res, write, end } = sseHarness()
    const cancel = vi.fn()
    createSessionMessageMock.mockResolvedValue({
      stream: new ReadableStream({ cancel }),
      completion: new Promise(() => {})
    })
    await createMessage(req, res)
    res.emit('close')
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('Client disconnected'))
    expect(write).not.toHaveBeenCalled()
    expect(end).toHaveBeenCalledOnce()
  })

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
import { EventEmitter } from 'node:events'
