import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureHeartbeatTask: vi.fn(),
  getAgent: vi.fn(),
  syncInheritedAgentSessionAccessiblePaths: vi.fn(),
  syncAgentSessionConfiguration: vi.fn(),
  syncAgentSessionInstructions: vi.fn(),
  syncAgentSessionModel: vi.fn(),
  syncScheduler: vi.fn(),
  updateAgent: vi.fn()
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
  agentService: {
    getAgent: (...args: unknown[]) => mocks.getAgent(...args),
    updateAgent: (...args: unknown[]) => mocks.updateAgent(...args)
  },
  sessionService: {
    syncInheritedAgentSessionAccessiblePaths: (...args: unknown[]) =>
      mocks.syncInheritedAgentSessionAccessiblePaths(...args),
    syncAgentSessionConfiguration: (...args: unknown[]) => mocks.syncAgentSessionConfiguration(...args),
    syncAgentSessionInstructions: (...args: unknown[]) => mocks.syncAgentSessionInstructions(...args),
    syncAgentSessionModel: (...args: unknown[]) => mocks.syncAgentSessionModel(...args)
  }
}))

vi.mock('@main/services/agents/services/channels', () => ({
  channelManager: {
    disconnectAgent: vi.fn()
  }
}))

vi.mock('@main/services/agents/services/SchedulerService', () => ({
  schedulerService: {
    ensureHeartbeatTask: (...args: unknown[]) => mocks.ensureHeartbeatTask(...args),
    syncScheduler: (...args: unknown[]) => mocks.syncScheduler(...args)
  }
}))

vi.mock('@shared/config/agents', () => ({
  isProtectedAgentId: () => false
}))

import { patchAgent } from '../agents'

describe('agent handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('treats an Agent model update as a default for future sessions', async () => {
    mocks.updateAgent.mockResolvedValue({
      id: 'agent-1',
      model: 'provider:model-b',
      configuration: {}
    })

    const req = {
      params: { agentId: 'agent-1' },
      validatedBody: { model: 'provider:model-b' }
    } as unknown as Request
    const json = vi.fn()
    const res = { json } as unknown as Response

    await patchAgent(req, res)

    expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', { model: 'provider:model-b' })
    expect(mocks.syncAgentSessionModel).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ model: 'provider:model-b' }))
  })

  it('continues to propagate shared Agent instructions without changing session models', async () => {
    mocks.updateAgent.mockResolvedValue({
      id: 'agent-1',
      model: 'provider:model-b',
      instructions: 'Updated instructions',
      configuration: {}
    })

    const req = {
      params: { agentId: 'agent-1' },
      validatedBody: {
        model: 'provider:model-b',
        instructions: 'Updated instructions'
      }
    } as unknown as Request
    const json = vi.fn()
    const res = { json } as unknown as Response

    await patchAgent(req, res)

    expect(mocks.syncAgentSessionInstructions).toHaveBeenCalledWith('agent-1', 'Updated instructions')
    expect(mocks.syncAgentSessionModel).not.toHaveBeenCalled()
  })

  it('synchronizes inherited session workspaces before returning an Agent update', async () => {
    mocks.getAgent.mockResolvedValue({
      id: 'agent-1',
      accessible_paths: ['C:\\workspace-a', 'C:\\workspace-b']
    })
    mocks.updateAgent.mockResolvedValue({
      id: 'agent-1',
      configuration: {},
      accessible_paths: ['C:\\workspace-b', 'C:\\workspace-a']
    })

    const req = {
      params: { agentId: 'agent-1' },
      validatedBody: {
        accessible_paths: ['C:\\workspace-b', 'C:\\workspace-a']
      }
    } as unknown as Request
    const json = vi.fn()
    const res = { json } as unknown as Response

    await patchAgent(req, res)

    expect(mocks.syncInheritedAgentSessionAccessiblePaths).toHaveBeenCalledWith(
      'agent-1',
      ['C:\\workspace-a', 'C:\\workspace-b'],
      ['C:\\workspace-b', 'C:\\workspace-a']
    )
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ accessible_paths: ['C:\\workspace-b', 'C:\\workspace-a'] })
    )
  })
})
