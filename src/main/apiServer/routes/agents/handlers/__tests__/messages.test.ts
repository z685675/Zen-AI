import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'

const { recordMainDiagnosticMock } = vi.hoisted(() => ({ recordMainDiagnosticMock: vi.fn() }))
vi.mock('@main/services/DiagnosticEvidenceService', () => ({ recordMainDiagnostic: recordMainDiagnosticMock }))
vi.mock('@main/services/agents', () => ({
  agentService: { agentExists: vi.fn(async () => false) },
  sessionService: {},
  sessionMessageService: {}
}))

import { createMessage } from '../messages'

describe('local agent API diagnostic boundary', () => {
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
})
