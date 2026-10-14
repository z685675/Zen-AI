import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ session: vi.fn(), inventory: vi.fn() }))
vi.mock('@main/services/agents', () => ({
  AgentModelValidationError: class extends Error {},
  sessionService: { getSession: mocks.session }
}))
vi.mock('@main/services/agents/services/LegacyContinuationService', () => ({ legacyContinuationService: {} }))
vi.mock('@main/services/agents/services/channels/sessionStreamIpc', () => ({ broadcastSessionChanged: vi.fn() }))
vi.mock('@main/services/agents/services/opencode/skillInventory', () => ({ getSessionSkillInventory: mocks.inventory }))

import { inspectSessionSkills } from '../sessions'

const response = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis(), sendStatus: vi.fn() })
const request = (agentId = 'zen-opencode-default') => ({ params: { agentId, sessionId: 's' } }) as unknown as Request
beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue({ id: 's', agent_id: 'zen-opencode-default' })
  mocks.inventory.mockResolvedValue({ nativeStatus: 'not-running', skills: [] })
})
describe('read-only Skill inventory handler', () => {
  it('restricts inspection to existing new-assistant sessions', async () => {
    const old = response()
    await inspectSessionSkills(request('old-assistant'), old as unknown as Response)
    expect(old.sendStatus).toHaveBeenCalledWith(404)
    expect(mocks.session).not.toHaveBeenCalled()
    const missing = response()
    mocks.session.mockResolvedValueOnce(null)
    await inspectSessionSkills(request(), missing as unknown as Response)
    expect(missing.sendStatus).toHaveBeenCalledWith(404)
    expect(mocks.inventory).not.toHaveBeenCalled()
  })
  it('reports an unstarted runtime honestly without requesting execution', async () => {
    const res = response()
    await inspectSessionSkills(request(), res as unknown as Response)
    expect(res.json).toHaveBeenCalledWith({ nativeStatus: 'not-running', skills: [] })
    expect(mocks.inventory).toHaveBeenCalledOnce()
  })
  it('reports collection failure without exposing paths or credentials', async () => {
    mocks.inventory.mockRejectedValue(new Error('private workspace key=secret'))
    const res = response()
    await inspectSessionSkills(request(), res as unknown as Response)
    expect(res.status).toHaveBeenCalledWith(503)
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret')
  })
})
