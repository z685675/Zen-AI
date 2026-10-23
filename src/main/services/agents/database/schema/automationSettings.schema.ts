import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/** Main-process-only authorization. Not part of editable agent configuration. */
export const automationSessions = sqliteTable('assistant_automation_sessions', {
  sessionId: text('session_id').primaryKey(),
  kind: text('kind', { enum: ['wechat', 'schedule'] }).notNull(),
  workspace: text('workspace').notNull(),
  createdAt: integer('created_at').notNull()
})

export const automationTaskSettings = sqliteTable('assistant_automation_task_settings', {
  taskId: text('task_id').primaryKey(),
  authorized: integer('authorized', { mode: 'boolean' }).notNull().default(false),
  notifyChannelId: text('notify_channel_id'),
  notifyVersion: integer('notify_version'),
  failures: integer('failures').notNull().default(0)
})

export const automationTaskSlots = sqliteTable(
  'assistant_automation_task_slots',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    slot: text('slot').notNull(),
    state: text('state', {
      enum: ['queued', 'running', 'completed', 'failed', 'stopped', 'interrupted', 'missed']
    }).notNull(),
    sessionId: text('session_id'),
    snapshot: text('snapshot').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [
    uniqueIndex('automation_task_slot_unique').on(t.taskId, t.slot),
    index('automation_task_slot_state').on(t.state),
    uniqueIndex('automation_task_single_active').on(t.taskId).where(sql`${t.state} IN ('queued','running')`)
  ]
)

export const automationFiles = sqliteTable('assistant_automation_files', {
  deliveryId: integer('delivery_id').primaryKey(),
  path: text('path').notNull(),
  sha256: text('sha256').notNull(),
  size: integer('size').notNull()
})

export const automationInputs = sqliteTable('assistant_automation_inputs', {
  runId: text('run_id').primaryKey(),
  paths: text('paths', { mode: 'json' }).$type<string[]>().notNull()
})
