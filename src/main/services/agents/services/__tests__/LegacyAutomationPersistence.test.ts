import { createClient } from '@libsql/client'
import { LEGACY_AUTOMATION_DISABLED_CODE } from '@shared/agents/legacyAutomation'
import { DEFAULT_DSH_AGENT_ID, DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { getTableColumns, getTableName } from 'drizzle-orm'
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

import { channelsTable, channelTaskSubscriptionsTable, scheduledTasksTable } from '../../database/schema'
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

  it('scopes legacy lists and deletes to historical owners before pagination and mutation', async () => {
    const client = createClient({ url: 'file::memory:' })
    const database = drizzle(client)
    const previous = mocks.getDatabase.getMockImplementation()
    mocks.getDatabase.mockResolvedValue(database as any)
    try {
      for (const table of [channelsTable, channelTaskSubscriptionsTable, scheduledTasksTable]) {
        const columns = Object.values(getTableColumns(table))
          .map((column) => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`)
          .join(', ')
        await client.execute(`CREATE TABLE "${getTableName(table)}" (${columns})`)
      }
      const channels = ChannelService.getInstance()
      const tasks = TaskService.getInstance()
      const config = { type: 'wechat' } as const
      const now = new Date().toISOString()
      for (const agentId of ['legacy', DEFAULT_OPENCODE_AGENT_ID, DEFAULT_DSH_AGENT_ID]) {
        await database.insert(channelsTable).values({ id: agentId, agentId, type: 'wechat', name: agentId, config })
        await database.insert(scheduledTasksTable).values({
          id: agentId,
          agent_id: agentId,
          name: agentId,
          prompt: 'fixture',
          schedule_type: 'interval',
          schedule_value: '60000',
          created_at: now,
          updated_at: now
        })
      }
      await database.insert(channelsTable).values({ id: 'unassigned', type: 'wechat', name: 'unassigned', config })

      expect((await channels.listChannels({ legacyOnly: true })).map(({ id }) => id).sort()).toEqual([
        'legacy',
        'unassigned'
      ])
      expect(await channels.listChannels({ agentId: DEFAULT_OPENCODE_AGENT_ID, legacyOnly: true })).toEqual([])
      expect(await tasks.listAllTasks({ legacyOnly: true, limit: 1 })).toMatchObject({
        total: 1,
        tasks: [{ id: 'legacy' }]
      })

      for (const id of [DEFAULT_OPENCODE_AGENT_ID, DEFAULT_DSH_AGENT_ID]) {
        expect(await channels.getChannel(id, true)).toBeNull()
        expect(await tasks.getTaskById(id, true)).toBeNull()
        expect(await channels.deleteChannel(id, true)).toBe(false)
        expect(await tasks.deleteTaskById(id, true)).toBe(false)
        expect(await channels.getChannel(id)).toMatchObject({ id })
        expect(await tasks.getTaskById(id)).toMatchObject({ id })
      }
      expect(await channels.deleteChannel('unassigned', true)).toBe(true)
      expect(await tasks.deleteTaskById('legacy', true)).toBe(true)
    } finally {
      if (previous) mocks.getDatabase.mockImplementation(previous)
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
