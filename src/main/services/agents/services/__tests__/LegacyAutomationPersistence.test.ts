import { createClient } from '@libsql/client'
import { LEGACY_AUTOMATION_DISABLED_CODE } from '@shared/agents/legacyAutomation'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { drizzle } from 'drizzle-orm/libsql'
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

  it('pauses legacy active tasks including heartbeat, but excludes OpenCode ownership', async () => {
    await TaskService.getInstance().pauseAllActiveTasks()
    expect(mocks.update).toHaveBeenCalledWith(scheduledTasksTable)
    expect(mocks.set).toHaveBeenCalledWith({ status: 'paused', updated_at: expect.any(String) })
    const query = new SQLiteSyncDialect().sqlToQuery(mocks.where.mock.calls[0][0])
    expect(query.sql).not.toContain('name')
    expect(query.params).toEqual(['active', DEFAULT_OPENCODE_AGENT_ID])
    expect(query.sql).toContain('"agent_id" <> ?')
  })

  it('only changes connection activation, preserving config, bindings and credentials', async () => {
    await ChannelService.getInstance().deactivateAllChannels()
    expect(mocks.update).toHaveBeenCalledWith(channelsTable)
    expect(mocks.set).toHaveBeenCalledWith({ isActive: false })
    expect(mocks.where).toHaveBeenCalledOnce()
    const query = new SQLiteSyncDialect().sqlToQuery(mocks.where.mock.calls[0][0])
    expect(query.sql).toContain('"agent_id" is null')
    expect(query.sql).toContain('"agent_id" <> ?')
    expect(query.params).toContain(DEFAULT_OPENCODE_AGENT_ID)
  })

  it('does not mark new-assistant in-flight records paused during legacy startup cleanup', async () => {
    const client = createClient({ url: 'file::memory:' })
    try {
      await client.executeMultiple(`
        CREATE TABLE scheduled_tasks (id text PRIMARY KEY, agent_id text);
        CREATE TABLE task_run_logs (id integer PRIMARY KEY, task_id text, run_at text, status text, error text, duration_ms integer);
      `)
      await client.batch([
        { sql: 'INSERT INTO scheduled_tasks VALUES (?, ?)', args: ['new-task', DEFAULT_OPENCODE_AGENT_ID] },
        { sql: 'INSERT INTO scheduled_tasks VALUES (?, ?)', args: ['old-task', 'legacy'] },
        {
          sql: "INSERT INTO task_run_logs VALUES (1, 'new-task', ?, 'running', NULL, 0)",
          args: [new Date().toISOString()]
        },
        {
          sql: "INSERT INTO task_run_logs VALUES (2, 'old-task', ?, 'waiting_user', NULL, 0)",
          args: [new Date().toISOString()]
        },
        {
          sql: "INSERT INTO task_run_logs VALUES (3, 'deleted-old-task', ?, 'running', NULL, 0)",
          args: [new Date().toISOString()]
        }
      ])
      mocks.getDatabase.mockResolvedValueOnce(drizzle(client))
      expect(
        await TaskService.getInstance().recoverInterruptedTaskRuns({ status: 'paused', message: 'legacy_disabled' })
      ).toBe(2)
      const rows = (await client.execute('SELECT id, status, error FROM task_run_logs ORDER BY id')).rows
      expect(rows).toEqual([
        { id: 1, status: 'running', error: null },
        { id: 2, status: 'paused', error: 'legacy_disabled' },
        { id: 3, status: 'paused', error: 'legacy_disabled' }
      ])
    } finally {
      client.close()
    }
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
