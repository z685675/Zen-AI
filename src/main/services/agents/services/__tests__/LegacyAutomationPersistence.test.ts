import { LEGACY_AUTOMATION_DISABLED_CODE } from '@shared/agents/legacyAutomation'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn(() => ({ where }))
  const update = vi.fn(() => ({ set }))
  const getDatabase = vi.fn().mockResolvedValue({ update })
  return { where, set, update, getDatabase }
})
vi.mock('../../BaseService', () => ({
  BaseService: class {
    getDatabase = mocks.getDatabase
  }
}))

import { channelsTable, scheduledTasksTable } from '../../database/schema'
import { ChannelService } from '../ChannelService'
import { TaskService } from '../TaskService'

describe('legacy persisted state shutdown', () => {
  beforeEach(() => vi.clearAllMocks())

  it('bulk pauses all active tasks, including heartbeat, without deleting history', async () => {
    await TaskService.getInstance().pauseAllActiveTasks()
    expect(mocks.update).toHaveBeenCalledWith(scheduledTasksTable)
    expect(mocks.set).toHaveBeenCalledWith({ status: 'paused', updated_at: expect.any(String) })
    const query = new SQLiteSyncDialect().sqlToQuery(mocks.where.mock.calls[0][0])
    expect(query.sql).not.toContain('name')
    expect(query.params).toEqual(['active'])
  })

  it('only changes connection activation, preserving config, bindings and credentials', async () => {
    await ChannelService.getInstance().deactivateAllChannels()
    expect(mocks.update).toHaveBeenCalledWith(channelsTable)
    expect(mocks.set).toHaveBeenCalledWith({ isActive: false })
    expect(mocks.where).toHaveBeenCalledOnce()
  })

  it('rejects new tasks and both task-resume service paths before any database writes', async () => {
    const service = TaskService.getInstance()
    await expect(service.createTask('legacy', {} as any)).rejects.toMatchObject({
      code: LEGACY_AUTOMATION_DISABLED_CODE
    })
    await expect(service.updateTask('legacy', 'id', { status: 'active' })).rejects.toMatchObject({
      code: LEGACY_AUTOMATION_DISABLED_CODE
    })
    await expect(service.updateTaskById('id', { status: 'active' })).rejects.toMatchObject({
      code: LEGACY_AUTOMATION_DISABLED_CODE
    })
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })

  it('rejects channel creation or activation without touching persisted credentials', async () => {
    const service = ChannelService.getInstance()
    await expect(service.createChannel({} as any)).rejects.toMatchObject({ code: LEGACY_AUTOMATION_DISABLED_CODE })
    await expect(service.updateChannel('wechat', { isActive: true })).rejects.toMatchObject({
      code: LEGACY_AUTOMATION_DISABLED_CODE
    })
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })
})
