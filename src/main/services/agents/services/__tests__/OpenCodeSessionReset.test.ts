import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ database: { delete: vi.fn() }, archive: vi.fn(), where: vi.fn() }))
vi.mock('../../BaseService', () => ({
  BaseService: class {
    getDatabase() {
      return Promise.resolve(mocks.database)
    }
  }
}))
vi.mock('../opencode/process', () => ({ archiveOpenCodeSession: mocks.archive }))
vi.mock('../claudecode/commands', () => ({ builtinSlashCommands: [] }))
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'

import { sessionMessagesTable, sessionsTable } from '../../database/schema'
import { SessionService } from '../SessionService'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.database.delete.mockReturnValue({ where: mocks.where })
  mocks.where.mockResolvedValue({ rowsAffected: 1 })
  mocks.archive.mockImplementation(async (_id, cleanup) => {
    await cleanup?.()
  })
})
describe('new assistant history reset', () => {
  it('resets display history inside the native-history lease', async () => {
    const service = new SessionService()
    vi.spyOn(service, 'sessionExists').mockResolvedValue(true)
    await service.resetOpenCodeMemory(DEFAULT_OPENCODE_AGENT_ID, 'session')
    expect(mocks.archive).toHaveBeenCalledWith('session', expect.any(Function))
    expect(mocks.database.delete).toHaveBeenCalledWith(sessionMessagesTable)
    expect(mocks.where).toHaveBeenCalledTimes(1)
  })
  it('does not touch legacy or nonexistent sessions', async () => {
    const service = new SessionService()
    vi.spyOn(service, 'sessionExists').mockResolvedValue(false)
    await expect(service.resetOpenCodeMemory('legacy', 'session')).rejects.toThrow('not found')
    await expect(service.resetOpenCodeMemory(DEFAULT_OPENCODE_AGENT_ID, 'session')).rejects.toThrow('not found')
    expect(mocks.archive).not.toHaveBeenCalled()
    expect(mocks.database.delete).not.toHaveBeenCalled()
  })
  it('leaves display history intact when native memory is busy', async () => {
    const service = new SessionService()
    vi.spyOn(service, 'sessionExists').mockResolvedValue(true)
    mocks.archive.mockRejectedValue(new Error('Stop task first'))
    await expect(service.resetOpenCodeMemory(DEFAULT_OPENCODE_AGENT_ID, 'session')).rejects.toThrow('Stop')
    expect(mocks.database.delete).not.toHaveBeenCalled()
  })
  it('deletes the session while still holding the native-history lease', async () => {
    const service = new SessionService()
    vi.spyOn(service, 'sessionExists').mockResolvedValue(true)
    expect(await service.deleteSession(DEFAULT_OPENCODE_AGENT_ID, 'session')).toBe(true)
    expect(mocks.archive).toHaveBeenCalledWith('session', expect.any(Function))
    expect(mocks.database.delete).toHaveBeenCalledWith(sessionsTable)
  })
})
