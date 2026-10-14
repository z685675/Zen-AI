import { EventEmitter } from 'node:events'

import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ run: vi.fn(), broadcast: vi.fn() }))
vi.mock('@main/services/agents', () => ({ AgentModelValidationError: class extends Error {}, sessionService: {} }))
vi.mock('@main/services/agents/services/LegacyContinuationService', () => ({
  legacyContinuationService: { continueSession: mocks.run }
}))
vi.mock('@main/services/agents/services/channels/sessionStreamIpc', () => ({
  broadcastSessionChanged: mocks.broadcast
}))

import { continueInNewAssistant } from '../sessions'

const request = { params: { agentId: 'legacy', sessionId: 'old' } } as unknown as Request
const response = () =>
  Object.assign(new EventEmitter(), { json: vi.fn(), status: vi.fn().mockReturnThis(), writableEnded: false })
beforeEach(() => vi.clearAllMocks())
describe('continuation HTTP handoff', () => {
  it('broadcasts only committed new copies', async () => {
    const result = { session: { id: 'copy' }, reused: false },
      res = response()
    mocks.run.mockResolvedValue(result)
    await continueInNewAssistant(request, res as unknown as Response)
    expect(res.json).toHaveBeenCalledWith(result)
    expect(mocks.broadcast).toHaveBeenCalledWith('zen-opencode-default', 'copy', false, 'created')
    expect(res.listenerCount('close')).toBe(0)
  })
  it.each([
    ['continuation_busy', 409],
    ['continuation_source_missing', 404],
    ['continuation_no_model', 422],
    ['disk secret path', 422]
  ])('handles %s without leaking private paths', async (code, status) => {
    const res = response()
    mocks.run.mockRejectedValue(Object.assign(new Error('private path /secret'), { code }))
    await continueInNewAssistant(request, res as unknown as Response)
    expect(res.status).toHaveBeenCalledWith(status)
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('/secret')
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })
  it('aborts preparations after the client disconnects', async () => {
    const res = response()
    mocks.run.mockImplementation(async (_agent, _session, signal) => {
      res.emit('close')
      signal.throwIfAborted()
    })
    await continueInNewAssistant(request, res as unknown as Response)
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })
})
