import { randomUUID } from 'node:crypto'

import type { AutomationTaskInput } from '@shared/agents/automation'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { CronExpressionParser } from 'cron-parser'
import { and, asc, eq, inArray } from 'drizzle-orm'

import {
  automationTaskSettings,
  automationTaskSlots,
  scheduledTasksTable,
  taskRunLogsTable
} from '../../database/schema'
import { assertAssistantDataAvailable } from '../dataOperationGate'
import { validateTaskSchedule } from '../taskSchedule'
import type { AutomationDatabase } from './AutomationRepository'

export function nextAutomationTime(type: string, value: string, now: number): string {
  validateTaskSchedule(type, value)
  if (type === 'once') return new Date(value).toISOString()
  if (type === 'interval') return new Date(now + Number(value) * 60_000).toISOString()
  const result = CronExpressionParser.parse(value, { currentDate: new Date(now) })
    .next()
    .toISOString()
  if (!result) throw new Error('automation_invalid_schedule')
  return result
}

export class AutomationScheduleRepository {
  constructor(
    private readonly database: () => Promise<AutomationDatabase>,
    private readonly now = Date.now
  ) {}
  private db() {
    assertAssistantDataAvailable()
    return this.database()
  }

  async tasks() {
    const db = await this.db()
    return db
      .select({ task: scheduledTasksTable, settings: automationTaskSettings })
      .from(scheduledTasksTable)
      .innerJoin(automationTaskSettings, eq(automationTaskSettings.taskId, scheduledTasksTable.id))
      .where(eq(scheduledTasksTable.agent_id, DEFAULT_OPENCODE_AGENT_ID))
  }

  async save(
    input: AutomationTaskInput,
    notification?: { channelId: string; version: number },
    id: string = randomUUID()
  ) {
    const next = nextAutomationTime(input.scheduleType, input.scheduleValue, this.now())
    if (input.scheduleType === 'once' && Date.parse(next) <= this.now()) throw new Error('automation_schedule_in_past')
    if (input.scheduleType === 'interval' && Number(input.scheduleValue) < 1)
      throw new Error('automation_invalid_schedule')
    const db = await this.db()
    await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(scheduledTasksTable).where(eq(scheduledTasksTable.id, id))
      if (
        !existing &&
        (await tx.select({ id: automationTaskSettings.taskId }).from(automationTaskSettings)).length >= 100
      )
        throw new Error('automation_task_limit')
      if (existing && existing.agent_id !== DEFAULT_OPENCODE_AGENT_ID) throw new Error('automation_invalid_owner')
      if (existing && !(await tx.select().from(automationTaskSettings).where(eq(automationTaskSettings.taskId, id)))[0])
        throw new Error('automation_not_authorized')
      const timestamp = new Date(this.now()).toISOString()
      await tx
        .insert(scheduledTasksTable)
        .values({
          id,
          agent_id: DEFAULT_OPENCODE_AGENT_ID,
          name: input.name,
          prompt: input.prompt,
          model_id: input.model ?? null,
          schedule_type: input.scheduleType,
          schedule_value: input.scheduleValue,
          next_run: next,
          status: 'active',
          created_at: timestamp,
          updated_at: timestamp
        })
        .onConflictDoUpdate({
          target: scheduledTasksTable.id,
          set: {
            name: input.name,
            prompt: input.prompt,
            model_id: input.model ?? null,
            schedule_type: input.scheduleType,
            schedule_value: input.scheduleValue,
            next_run: next,
            status: 'active',
            updated_at: timestamp
          }
        })
      const settings = {
        authorized: true,
        notifyChannelId: input.notify ? (notification?.channelId ?? null) : null,
        notifyVersion: input.notify ? (notification?.version ?? null) : null,
        failures: 0
      }
      if (input.notify && !notification) throw new Error('automation_notification_not_bound')
      await tx
        .insert(automationTaskSettings)
        .values({ taskId: id, ...settings })
        .onConflictDoUpdate({ target: automationTaskSettings.taskId, set: settings })
    })
    return id
  }

  async setStatus(id: string, action: 'pause' | 'resume' | 'delete') {
    const row = (await this.tasks()).find((entry) => entry.task.id === id)
    if (!row) throw new Error('automation_task_missing')
    if (action === 'resume' && row.task.schedule_type === 'once' && Date.parse(row.task.schedule_value) <= this.now())
      throw new Error('automation_schedule_in_past')
    const db = await this.db()
    const pending = await db
      .select()
      .from(automationTaskSlots)
      .where(and(eq(automationTaskSlots.taskId, id), inArray(automationTaskSlots.state, ['queued', 'running'])))
    if (action !== 'pause' && pending.some((slot) => slot.state === 'running')) throw new Error('automation_task_busy')
    await db.transaction(async (tx) => {
      await tx
        .update(automationTaskSlots)
        .set({ state: 'stopped' })
        .where(and(eq(automationTaskSlots.taskId, id), eq(automationTaskSlots.state, 'queued')))
      if (action === 'delete') {
        await tx.delete(automationTaskSettings).where(eq(automationTaskSettings.taskId, id))
        await tx.delete(scheduledTasksTable).where(eq(scheduledTasksTable.id, id))
      } else
        await tx
          .update(scheduledTasksTable)
          .set({
            status: action === 'pause' ? 'paused' : 'active',
            next_run:
              action === 'resume'
                ? nextAutomationTime(row.task.schedule_type, row.task.schedule_value, this.now())
                : row.task.next_run,
            updated_at: new Date(this.now()).toISOString()
          })
          .where(eq(scheduledTasksTable.id, id))
      if (action === 'resume')
        await tx.update(automationTaskSettings).set({ failures: 0 }).where(eq(automationTaskSettings.taskId, id))
    })
  }

  async enqueue(id: string, manual = false, skipMissed = false) {
    const db = await this.db()
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ task: scheduledTasksTable, settings: automationTaskSettings })
        .from(scheduledTasksTable)
        .innerJoin(automationTaskSettings, eq(automationTaskSettings.taskId, scheduledTasksTable.id))
        .where(
          and(
            eq(scheduledTasksTable.id, id),
            eq(scheduledTasksTable.agent_id, DEFAULT_OPENCODE_AGENT_ID),
            eq(automationTaskSettings.authorized, true)
          )
        )
      if (!row || (!manual && row.task.status !== 'active')) return
      if (!manual && (!row.task.next_run || Date.parse(row.task.next_run) > this.now())) return
      const [active] = await tx
        .select()
        .from(automationTaskSlots)
        .where(and(eq(automationTaskSlots.taskId, id), inArray(automationTaskSlots.state, ['queued', 'running'])))
      if (active) return
      const missed = !manual && (skipMissed || this.now() - Date.parse(row.task.next_run!) > 90_000)
      const slotId = randomUUID()
      const [slot] = await tx
        .insert(automationTaskSlots)
        .values({
          id: slotId,
          taskId: id,
          slot: manual ? `manual:${slotId}` : row.task.next_run!,
          state: missed ? 'missed' : 'queued',
          snapshot: JSON.stringify(row),
          createdAt: this.now()
        })
        .onConflictDoNothing()
        .returning()
      if (!slot) return
      if (!manual)
        await tx
          .update(scheduledTasksTable)
          .set({
            next_run:
              row.task.schedule_type === 'once'
                ? null
                : nextAutomationTime(row.task.schedule_type, row.task.schedule_value, this.now()),
            status: row.task.schedule_type === 'once' ? 'completed' : 'active'
          })
          .where(eq(scheduledTasksTable.id, id))
      if (missed)
        await tx.insert(taskRunLogsTable).values({
          task_id: id,
          trigger_type: 'scheduled',
          scheduled_for: slot.slot,
          run_at: new Date(this.now()).toISOString(),
          duration_ms: 0,
          status: 'missed',
          error: 'automation_schedule_missed'
        })
      return slot
    })
  }

  async pending() {
    const db = await this.db()
    return db
      .select()
      .from(automationTaskSlots)
      .where(eq(automationTaskSlots.state, 'queued'))
      .orderBy(asc(automationTaskSlots.createdAt))
      .limit(32)
  }

  async cancelQueued(id: string) {
    const db = await this.db()
    await db
      .update(automationTaskSlots)
      .set({ state: 'stopped' })
      .where(and(eq(automationTaskSlots.taskId, id), eq(automationTaskSlots.state, 'queued')))
  }

  async rebaseRecurring() {
    const db = await this.db()
    for (const { task } of await this.tasks())
      if (task.status === 'active' && task.schedule_type !== 'once') {
        await db
          .update(scheduledTasksTable)
          .set({ next_run: nextAutomationTime(task.schedule_type, task.schedule_value, this.now()) })
          .where(eq(scheduledTasksTable.id, task.id))
      }
  }

  /** Waiting for a task slot is finite; never execute stale background requests hours later. */
  async expireQueued(id: string) {
    const db = await this.db()
    return db.transaction(async (tx) => {
      const [slot] = await tx.select().from(automationTaskSlots).where(eq(automationTaskSlots.id, id))
      if (!slot || slot.state !== 'queued' || this.now() - slot.createdAt <= 10 * 60_000) return false
      await tx.update(automationTaskSlots).set({ state: 'missed' }).where(eq(automationTaskSlots.id, id))
      await tx.insert(taskRunLogsTable).values({
        task_id: slot.taskId,
        session_id: slot.sessionId,
        trigger_type: slot.slot.startsWith('manual:') ? 'manual' : 'scheduled',
        scheduled_for: slot.slot,
        run_at: new Date(this.now()).toISOString(),
        duration_ms: 0,
        status: 'missed',
        error: 'automation_queue_expired'
      })
      return true
    })
  }

  async claim(id: string, sessionId: string, model: string) {
    const db = await this.db()
    return db.transaction(async (tx) => {
      const [slot] = await tx
        .update(automationTaskSlots)
        .set({ state: 'running', sessionId })
        .where(and(eq(automationTaskSlots.id, id), eq(automationTaskSlots.state, 'queued')))
        .returning()
      if (!slot) throw new Error('automation_slot_changed')
      const [log] = await tx
        .insert(taskRunLogsTable)
        .values({
          task_id: slot.taskId,
          session_id: sessionId,
          model_id: model,
          trigger_type: slot.slot.startsWith('manual:') ? 'manual' : 'scheduled',
          scheduled_for: slot.slot.startsWith('manual:') ? null : slot.slot,
          run_at: new Date(this.now()).toISOString(),
          duration_ms: 0,
          status: 'running'
        })
        .returning()
      return log
    })
  }

  async finish(
    id: string,
    logId: number,
    outcome: 'completed' | 'failed' | 'stopped',
    result: string,
    duration: number
  ) {
    const db = await this.db()
    await db.transaction(async (tx) => {
      const [slot] = await tx.select().from(automationTaskSlots).where(eq(automationTaskSlots.id, id))
      if (!slot || slot.state !== 'running') return
      await tx.update(automationTaskSlots).set({ state: outcome }).where(eq(automationTaskSlots.id, id))
      await tx
        .update(taskRunLogsTable)
        .set({
          status: outcome === 'completed' ? 'success' : outcome === 'failed' ? 'error' : 'paused',
          result: outcome === 'completed' ? result.slice(0, 24_000) : null,
          error: outcome === 'completed' ? null : result,
          duration_ms: Math.max(0, duration)
        })
        .where(eq(taskRunLogsTable.id, logId))
      const [settings] = await tx
        .select()
        .from(automationTaskSettings)
        .where(eq(automationTaskSettings.taskId, slot.taskId))
      const failures =
        outcome === 'completed' ? 0 : outcome === 'failed' ? (settings?.failures ?? 0) + 1 : (settings?.failures ?? 0)
      await tx.update(automationTaskSettings).set({ failures }).where(eq(automationTaskSettings.taskId, slot.taskId))
      await tx
        .update(scheduledTasksTable)
        .set({
          last_run: new Date(this.now()).toISOString(),
          last_result: result.slice(0, 24_000),
          ...(failures >= 3 ? { status: 'paused' } : {})
        })
        .where(eq(scheduledTasksTable.id, slot.taskId))
    })
  }

  async recover() {
    const db = await this.db()
    await db.transaction(async (tx) => {
      const slots = await tx
        .select()
        .from(automationTaskSlots)
        .where(inArray(automationTaskSlots.state, ['queued', 'running']))
      await tx
        .update(automationTaskSlots)
        .set({ state: 'interrupted' })
        .where(inArray(automationTaskSlots.state, ['queued', 'running']))
      for (const slot of slots)
        await tx
          .update(taskRunLogsTable)
          .set({ status: 'paused', error: 'automation_process_interrupted' })
          .where(and(eq(taskRunLogsTable.task_id, slot.taskId), eq(taskRunLogsTable.status, 'running')))
    })
  }
}
