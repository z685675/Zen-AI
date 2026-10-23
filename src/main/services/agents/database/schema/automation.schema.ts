import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/** V1: one explicitly confirmed account/recipient/current conversation per channel. */
export const automationBindings = sqliteTable(
  'assistant_automation_bindings',
  {
    channelId: text('channel_id').primaryKey(),
    accountId: text('account_id').notNull(),
    peerId: text('peer_id').notNull(),
    sessionId: text('session_id').notNull(),
    version: integer('version').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [
    uniqueIndex('automation_active_session_idx').on(t.sessionId).where(sql`${t.enabled} = 1`),
    uniqueIndex('automation_active_peer_idx').on(t.accountId, t.peerId).where(sql`${t.enabled} = 1`),
    check('automation_binding_version_check', sql`${t.version} > 0`)
  ]
)

export const automationRuns = sqliteTable(
  'assistant_automation_runs',
  {
    id: text('id').primaryKey(),
    sourceKey: text('source_key').notNull(),
    origin: text('origin', { enum: ['wechat', 'desktop'] }).notNull(),
    channelId: text('channel_id').notNull(),
    bindingVersion: integer('binding_version').notNull(),
    sessionId: text('session_id').notNull(),
    state: text('state', { enum: ['queued', 'running', 'completed', 'failed', 'stopped', 'interrupted'] }).notNull(),
    input: text('input').notNull(),
    result: text('result'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [
    uniqueIndex('automation_source_key_idx').on(t.sourceKey),
    uniqueIndex('automation_running_session_idx').on(t.sessionId).where(sql`${t.state} = 'running'`),
    index('automation_run_channel_idx').on(t.channelId, t.state),
    check('automation_run_origin_check', sql`${t.origin} IN ('wechat', 'desktop')`),
    check(
      'automation_run_state_check',
      sql`${t.state} IN ('queued', 'running', 'completed', 'failed', 'stopped', 'interrupted')`
    )
  ]
)

/** Text delivery only in the first batch; verified file delivery is a separate task. */
export const automationOutbox = sqliteTable(
  'assistant_automation_outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deliveryKey: text('delivery_key').notNull(),
    runId: text('run_id').notNull(),
    channelId: text('channel_id').notNull(),
    accountId: text('account_id').notNull(),
    peerId: text('peer_id').notNull(),
    sessionId: text('session_id').notNull(),
    bindingVersion: integer('binding_version').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'notice'] }).notNull(),
    text: text('text').notNull(),
    state: text('state', {
      enum: ['pending', 'sending', 'accepted', 'retry_wait', 'failed', 'unknown', 'cancelled']
    }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    lease: text('lease'),
    reason: text('reason'),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [
    uniqueIndex('automation_delivery_key_idx').on(t.deliveryKey),
    index('automation_outbox_channel_idx').on(t.channelId, t.id),
    check('automation_outbox_role_check', sql`${t.role} IN ('user', 'assistant', 'notice')`),
    check(
      'automation_outbox_state_check',
      sql`${t.state} IN ('pending', 'sending', 'accepted', 'retry_wait', 'failed', 'unknown', 'cancelled')`
    )
  ]
)

export type AutomationBinding = typeof automationBindings.$inferSelect
export type AutomationRun = typeof automationRuns.$inferSelect
export type AutomationDelivery = typeof automationOutbox.$inferSelect
