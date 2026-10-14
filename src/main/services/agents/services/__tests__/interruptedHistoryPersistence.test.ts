import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rows: [] as any[], update: vi.fn(), active: false, applied: 1 }))
vi.mock('../../BaseService', () => ({
  BaseService: class {
    async getDatabase() {
      return {
        select: () => ({ from: () => ({ where: () => ({ orderBy: async () => mocks.rows }) }) }),
        update: () => ({
          set: (value: unknown) => ({
            where: async (condition: unknown) => {
              mocks.update(value, condition)
              return { rowsAffected: mocks.applied }
            }
          })
        })
      }
    }
  }
}))
vi.mock('../sessionActivity', () => ({ hasSessionActivity: () => mocks.active }))

import { agentMessageRepository } from '../../database/sessionMessageRepository'

const row = (assistantId = DEFAULT_OPENCODE_AGENT_ID) => ({
  id: 1,
  content: JSON.stringify({
    message: {
      id: 'reply',
      role: 'assistant',
      assistantId,
      status: 'processing',
      createdAt: '2020-01-01T00:00:00Z',
      blocks: []
    },
    blocks: []
  })
})
beforeEach(() => {
  mocks.rows = [row()]
  mocks.update.mockClear()
  mocks.active = false
  mocks.applied = 1
})
describe('lazy durable restart repair', () => {
  it('persists stale display state on first history read without changing schema or native memory', async () => {
    const result = await agentMessageRepository.getSessionHistory('session')
    expect(result[0].message.status).toBe('paused')
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(
      JSON.parse(mocks.update.mock.calls[0][0].content).message.providerMetadata.zenInterrupted.automaticReplay
    ).toBe(false)
  })
  it.each([true, false])('does not repair live work or legacy history (active=%s)', async (active) => {
    mocks.active = active
    if (!active) mocks.rows = [row('old-assistant')]
    expect((await agentMessageRepository.getSessionHistory('session'))[0].message.status).toBe('processing')
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it('reloads a concurrent final write instead of returning an incorrect interrupted state', async () => {
    mocks.applied = 0
    mocks.update.mockImplementationOnce(() => {
      const payload = JSON.parse(mocks.rows[0].content)
      payload.message.status = 'success'
      mocks.rows = [{ ...mocks.rows[0], content: JSON.stringify(payload) }]
    })
    expect((await agentMessageRepository.getSessionHistory('session'))[0].message.status).toBe('success')
    expect(mocks.update).toHaveBeenCalledOnce()
  })
})
