import fs from 'node:fs'
import path from 'node:path'

import { type Client, createClient } from '@libsql/client'
import type { AutomationTaskInput } from '@shared/agents/automation'
import { drizzle } from 'drizzle-orm/libsql'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '../../../database/schema'
import { AutomationScheduleRepository, nextAutomationTime } from '../AutomationScheduleRepository'

vi.unmock('node:fs')
vi.unmock('node:path')
const migration = fs.readFileSync(
  path.resolve('resources/database/drizzle/0010_assistant_automation_settings.sql'),
  'utf8'
)
const task: AutomationTaskInput = {
  name: 'weekly notes',
  prompt: 'Summarize recent public news',
  scheduleType: 'interval',
  scheduleValue: '5',
  authorized: true,
  notify: false
}

describe('durable new assistant schedules', () => {
  let client: Client
  let repository: AutomationScheduleRepository
  let now: number
  beforeEach(async () => {
    now = Date.parse('2026-10-15T04:00:00Z')
    client = createClient({ url: 'file::memory:?cache=shared' })
    await client.executeMultiple(`DROP TABLE IF EXISTS assistant_automation_task_slots; DROP TABLE IF EXISTS assistant_automation_task_settings;
      DROP TABLE IF EXISTS scheduled_tasks; DROP TABLE IF EXISTS task_run_logs;
      CREATE TABLE scheduled_tasks(id TEXT PRIMARY KEY, agent_id TEXT, model_id TEXT, name TEXT, prompt TEXT, schedule_type TEXT, schedule_value TEXT, timeout_minutes INTEGER DEFAULT 60, next_run TEXT, last_run TEXT, last_result TEXT, status TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE task_run_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, session_id TEXT, model_id TEXT, trigger_type TEXT, scheduled_for TEXT, run_at TEXT, duration_ms INTEGER, status TEXT, result TEXT, error TEXT);`)
    await client.executeMultiple(migration)
    repository = new AutomationScheduleRepository(
      async () => drizzle(client, { schema }),
      () => now
    )
  })
  afterEach(() => client.close())
  it('requires explicit notification binding and rolls back the entire create', async () => {
    await expect(repository.save({ ...task, notify: true })).rejects.toThrow('not_bound')
    expect(await repository.tasks()).toEqual([])
  })
  it('deduplicates concurrent scans, manual clicks and one active task across slots', async () => {
    const id = await repository.save(task)
    now += 300_000
    const first = await repository.enqueue(id)
    expect(first?.state).toBe('queued')
    expect(await repository.enqueue(id)).toBeUndefined()
    expect(await repository.enqueue(id, true)).toBeUndefined()
    const log = await repository.claim(first!.id, 'session', 'zen:model')
    await expect(repository.claim(first!.id, 'other', 'zen:model')).rejects.toThrow('slot_changed')
    await repository.finish(first!.id, log.id, 'completed', 'done', 200)
    expect((await repository.tasks())[0].task.last_result).toBe('done')
    expect((await repository.enqueue(id, true))?.slot).toMatch(/^manual:/)
  })
  it('never catches up missed cycles after sleep, and advances from current time', async () => {
    const id = await repository.save(task)
    now += 3600_000
    expect((await repository.enqueue(id))?.state).toBe('missed')
    expect(await repository.pending()).toEqual([])
    expect((await repository.tasks())[0].task.next_run).toBe(new Date(now + 300_000).toISOString())
  })
  it('does not silently resume an overdue once task', async () => {
    const id = await repository.save({
      ...task,
      scheduleType: 'once',
      scheduleValue: new Date(now + 60_000).toISOString()
    })
    await repository.setStatus(id, 'pause')
    now += 120_000
    await expect(repository.setStatus(id, 'resume')).rejects.toThrow('schedule_in_past')
    expect((await repository.enqueue(id, true))?.state).toBe('queued')
  })
  it('expires a queued slot without calling a model or incrementing failures', async () => {
    const id = await repository.save(task)
    const slot = await repository.enqueue(id, true)
    expect(await repository.expireQueued(slot!.id)).toBe(false)
    now += 600_001
    expect(await repository.expireQueued(slot!.id)).toBe(true)
    expect(await repository.pending()).toEqual([])
    expect((await repository.tasks())[0].settings.failures).toBe(0)
    expect((await client.execute('SELECT status,error FROM task_run_logs')).rows[0]).toMatchObject({
      status: 'missed',
      error: 'automation_queue_expired'
    })
  })
  it('cancels queued slots on pause without changing a running snapshot', async () => {
    const id = await repository.save(task)
    await repository.enqueue(id, true)
    await repository.setStatus(id, 'pause')
    expect(await repository.pending()).toEqual([])
    await repository.setStatus(id, 'resume')
    const slot = await repository.enqueue(id, true)
    await repository.claim(slot!.id, 'session', 'model')
    await repository.save({ ...task, prompt: 'NEW instructions' }, undefined, id)
    const stored = await client.execute({
      sql: 'SELECT snapshot FROM assistant_automation_task_slots WHERE id=?',
      args: [slot!.id]
    })
    expect(JSON.parse(String(stored.rows[0].snapshot)).task.prompt).toBe(task.prompt)
    await expect(repository.setStatus(id, 'delete')).rejects.toThrow('task_busy')
  })
  it('pauses after three actual failures, not a stopped run', async () => {
    const id = await repository.save(task)
    for (const outcome of ['failed', 'stopped', 'failed', 'failed'] as const) {
      const slot = await repository.enqueue(id, true)
      const log = await repository.claim(slot!.id, 'session', 'model')
      await repository.finish(slot!.id, log.id, outcome, 'reason', 1)
    }
    expect((await repository.tasks())[0].settings.failures).toBe(3)
    expect((await repository.tasks())[0].task.status).toBe('paused')
  })
  it('recovers as interrupted and never replays a running slot', async () => {
    const id = await repository.save(task)
    const slot = await repository.enqueue(id, true)
    await repository.claim(slot!.id, 'session', 'model')
    await repository.recover()
    expect(await repository.pending()).toEqual([])
    expect((await client.execute('SELECT state FROM assistant_automation_task_slots')).rows[0].state).toBe(
      'interrupted'
    )
    expect((await client.execute('SELECT status FROM task_run_logs')).rows[0].status).toBe('paused')
  })
  it('does not authorize an old task by copying its ID', async () => {
    await client.execute("INSERT INTO scheduled_tasks(id,agent_id) VALUES('old','legacy')")
    await expect(repository.save(task, undefined, 'old')).rejects.toThrow('invalid_owner')
    expect(await repository.enqueue('old', true)).toBeUndefined()
  })
  it('computes finite interval/once/cron times without model heartbeats', () => {
    expect(nextAutomationTime('interval', '5', now)).toBe(new Date(now + 300_000).toISOString())
    expect(Date.parse(nextAutomationTime('cron', '0 9 * * *', now))).toBeGreaterThan(now)
    expect(() => nextAutomationTime('interval', '0', now)).toThrow()
  })
})
