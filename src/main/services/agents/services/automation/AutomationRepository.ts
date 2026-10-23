import { createHash, randomUUID } from 'node:crypto'

import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { and, asc, count, eq, inArray, lt, notInArray, sql } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import type * as schema from '../../database/schema'
import {
  type AutomationBinding,
  automationBindings,
  type AutomationDelivery,
  automationFiles,
  automationOutbox,
  automationRuns,
  channelsTable,
  sessionsTable
} from '../../database/schema'
import { assertAssistantDataAvailable } from '../dataOperationGate'

export type AutomationDatabase = LibSQLDatabase<typeof schema>
export type AutomationTarget = Pick<AutomationBinding, 'channelId' | 'accountId' | 'peerId' | 'sessionId' | 'version'>
/** `retryable` requires proof of non-acceptance, not merely a timeout or a broken connection. */
export type DeliveryOutcome = { status: 'accepted' } | { status: 'retryable' | 'failed' | 'unknown'; reason: string }

const MAX_TEXT_BYTES = 1024 * 1024
const MAX_DELIVERY_ATTEMPTS = 3
const DELIVERY_TTL_MS = 6 * 60 * 60_000
const MAX_QUEUED_RUNS_PER_CHANNEL = 16
const mutableDeliveryStates = ['pending', 'retry_wait', 'failed', 'unknown'] as const

function fail(code: string): never {
  // Codes are intentionally content-free. Never place credentials or message bodies in an error.
  throw Object.assign(new Error(code), { code })
}

function identifier(value: string): void {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 512 ||
    value !== value.trim() ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    fail('automation_invalid_identity')
}

function text(value: string): void {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > MAX_TEXT_BYTES)
    fail('automation_invalid_text')
}

function sameTarget(binding: AutomationBinding | undefined, target: AutomationTarget): boolean {
  return !!(
    binding?.enabled &&
    binding.channelId === target.channelId &&
    binding.accountId === target.accountId &&
    binding.peerId === target.peerId &&
    binding.sessionId === target.sessionId &&
    binding.version === target.version
  )
}

/** Authorization disappears when either its connection or conversation disappears. */
async function authorizedBinding(db: Pick<AutomationDatabase, 'select'>, channelId: string) {
  const [row] = await db
    .select({ binding: automationBindings })
    .from(automationBindings)
    .innerJoin(
      channelsTable,
      and(
        eq(channelsTable.id, automationBindings.channelId),
        eq(channelsTable.agentId, DEFAULT_OPENCODE_AGENT_ID),
        eq(channelsTable.type, 'wechat'),
        eq(channelsTable.isActive, true)
      )
    )
    .innerJoin(
      sessionsTable,
      and(eq(sessionsTable.id, automationBindings.sessionId), eq(sessionsTable.agent_id, DEFAULT_OPENCODE_AGENT_ID))
    )
    .where(eq(automationBindings.channelId, channelId))
  return row?.binding
}

export function deliveryTarget(delivery: AutomationDelivery): AutomationTarget {
  return {
    channelId: delivery.channelId,
    accountId: delivery.accountId,
    peerId: delivery.peerId,
    sessionId: delivery.sessionId,
    version: delivery.bindingVersion
  }
}

function key(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** Bound UTF-16 length as well as character count, without splitting a surrogate pair. */
export function splitAutomationText(value: string, limit = 1800): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) fail('automation_invalid_chunk_limit')
  text(value)
  const chunks: string[] = []
  let current = ''
  for (const character of value) {
    if (character.length > limit) fail('automation_invalid_chunk_limit')
    if (current.length + character.length > limit) {
      chunks.push(current)
      current = ''
    }
    current += character
  }
  if (current) chunks.push(current)
  return chunks
}

/**
 * Durable perimeter only: no model calls, background timers or legacy-feature activation.
 * The executor must still acquire the existing shared sessionActivity lease before claimRun.
 */
export class AutomationRepository {
  constructor(
    private readonly database: () => Promise<AutomationDatabase>,
    private readonly now: () => number = Date.now
  ) {}

  private getDatabase() {
    assertAssistantDataAvailable()
    return this.database()
  }

  async getBinding(channelId: string): Promise<AutomationBinding | undefined> {
    identifier(channelId)
    const db = await this.getDatabase()
    return authorizedBinding(db, channelId)
  }

  async bindingForSession(sessionId: string) {
    const db = await this.getDatabase()
    const [binding] = await db.select().from(automationBindings).where(eq(automationBindings.sessionId, sessionId))
    return binding?.enabled ? authorizedBinding(db, binding.channelId) : undefined
  }

  async getStoredBinding(channelId: string) {
    const db = await this.getDatabase()
    return (await db.select().from(automationBindings).where(eq(automationBindings.channelId, channelId)))[0]
  }

  async queued() {
    const db = await this.getDatabase()
    return db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.state, 'queued'))
      .orderBy(asc(sql`${automationRuns}.rowid`))
      .limit(64)
  }

  async deliveries(channelId: string) {
    const db = await this.getDatabase()
    return db
      .select()
      .from(automationOutbox)
      .where(eq(automationOutbox.channelId, channelId))
      .orderBy(sql`${automationOutbox.id} desc`)
      .limit(200)
  }

  /** A retry is an explicit user decision, never an automatic replay of unknown acceptance. */
  async resolveDelivery(id: number, action: 'retry' | 'cancel') {
    const db = await this.getDatabase()
    await db.transaction(async (tx) => {
      const [item] = await tx.select().from(automationOutbox).where(eq(automationOutbox.id, id))
      if (!item || !['failed', 'unknown', 'pending', 'retry_wait'].includes(item.state))
        fail('automation_delivery_busy')
      if (
        action === 'retry' &&
        (!sameTarget(await authorizedBinding(tx, item.channelId), deliveryTarget(item)) || item.expiresAt <= this.now())
      )
        fail('automation_delivery_expired')
      await tx
        .update(automationOutbox)
        .set({
          state: action === 'retry' ? 'pending' : 'cancelled',
          attempts: 0,
          reason: null,
          nextAttemptAt: this.now(),
          updatedAt: this.now()
        })
        .where(eq(automationOutbox.id, id))
    })
  }

  async enqueueFile(runId: string, file: { path: string; sha256: string; size: number }) {
    const db = await this.getDatabase()
    await db.transaction(async (tx) => {
      const [run] = await tx.select().from(automationRuns).where(eq(automationRuns.id, runId))
      if (!run || run.state !== 'completed') fail('automation_run_not_completed')
      const binding = await authorizedBinding(tx, run.channelId)
      if (!binding || binding.version !== run.bindingVersion || binding.sessionId !== run.sessionId) return
      const [delivery] = await tx
        .insert(automationOutbox)
        .values({
          deliveryKey: key([runId, 'file', file.path, file.sha256]),
          runId,
          channelId: binding.channelId,
          accountId: binding.accountId,
          peerId: binding.peerId,
          sessionId: binding.sessionId,
          bindingVersion: binding.version,
          role: 'assistant',
          text: '[file]',
          state: 'pending',
          nextAttemptAt: this.now(),
          expiresAt: this.now() + DELIVERY_TTL_MS,
          createdAt: this.now(),
          updatedAt: this.now()
        })
        .onConflictDoNothing()
        .returning()
      if (delivery) await tx.insert(automationFiles).values({ deliveryId: delivery.id, ...file })
    })
  }

  async fileForDelivery(id: number) {
    const db = await this.getDatabase()
    return (await db.select().from(automationFiles).where(eq(automationFiles.deliveryId, id)))[0]
  }

  async enqueueNotice(
    target: AutomationTarget,
    notificationId: string,
    value: string,
    files: Array<{ path: string; sha256: string; size: number }> = []
  ) {
    text(value)
    const db = await this.getDatabase()
    await db.transaction(async (tx) => {
      if (!sameTarget(await authorizedBinding(tx, target.channelId), target)) return
      const parts = splitAutomationText(value)
      for (const [index, part] of parts.entries())
        await tx
          .insert(automationOutbox)
          .values({
            deliveryKey: key([notificationId, 'notice', String(index)]),
            runId: notificationId,
            channelId: target.channelId,
            accountId: target.accountId,
            peerId: target.peerId,
            sessionId: target.sessionId,
            bindingVersion: target.version,
            role: 'notice',
            text: part,
            state: 'pending',
            nextAttemptAt: this.now(),
            expiresAt: this.now() + DELIVERY_TTL_MS,
            createdAt: this.now(),
            updatedAt: this.now()
          })
          .onConflictDoNothing()
      for (const file of files) {
        const [delivery] = await tx
          .insert(automationOutbox)
          .values({
            deliveryKey: key([notificationId, 'file', file.sha256, file.path]),
            runId: notificationId,
            channelId: target.channelId,
            accountId: target.accountId,
            peerId: target.peerId,
            sessionId: target.sessionId,
            bindingVersion: target.version,
            role: 'notice',
            text: '[file]',
            state: 'pending',
            nextAttemptAt: this.now(),
            expiresAt: this.now() + DELIVERY_TTL_MS,
            createdAt: this.now(),
            updatedAt: this.now()
          })
          .onConflictDoNothing()
          .returning()
        if (delivery) await tx.insert(automationFiles).values({ deliveryId: delivery.id, ...file })
      }
    })
  }

  async isCurrentTarget(target: AutomationTarget): Promise<boolean> {
    return sameTarget(await this.getBinding(target.channelId), target)
  }

  /** Explicit desktop authorization with compare-and-swap; never called by a model tool. */
  async bind(target: Omit<AutomationTarget, 'version'>, expectedVersion: number): Promise<AutomationBinding> {
    ;[target.channelId, target.accountId, target.peerId, target.sessionId].forEach(identifier)
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= 2_147_483_646)
      fail('automation_invalid_version')
    const db = await this.getDatabase()
    return db.transaction(async (tx) => {
      const [channel] = await tx
        .select({ id: channelsTable.id })
        .from(channelsTable)
        .where(
          and(
            eq(channelsTable.id, target.channelId),
            eq(channelsTable.agentId, DEFAULT_OPENCODE_AGENT_ID),
            eq(channelsTable.type, 'wechat'),
            eq(channelsTable.isActive, true)
          )
        )
      const [session] = await tx
        .select({ id: sessionsTable.id })
        .from(sessionsTable)
        .where(and(eq(sessionsTable.id, target.sessionId), eq(sessionsTable.agent_id, DEFAULT_OPENCODE_AGENT_ID)))
      if (!channel || !session) fail('automation_invalid_owner')
      const [current] = await tx
        .select()
        .from(automationBindings)
        .where(eq(automationBindings.channelId, target.channelId))
      if ((current?.version ?? 0) !== expectedVersion) fail('automation_binding_changed')
      const [running] = await tx
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(and(eq(automationRuns.channelId, target.channelId), eq(automationRuns.state, 'running')))
      const [sending] = await tx
        .select({ id: automationOutbox.id })
        .from(automationOutbox)
        .where(and(eq(automationOutbox.channelId, target.channelId), eq(automationOutbox.state, 'sending')))
      if (running || sending) fail('automation_binding_busy')
      const binding = { ...target, version: expectedVersion + 1, enabled: true, updatedAt: this.now() }
      await tx
        .insert(automationBindings)
        .values(binding)
        .onConflictDoUpdate({ target: automationBindings.channelId, set: binding })
      await tx
        .update(automationOutbox)
        .set({ state: 'cancelled', reason: 'binding_changed', updatedAt: this.now() })
        .where(
          and(eq(automationOutbox.channelId, target.channelId), inArray(automationOutbox.state, mutableDeliveryStates))
        )
      await tx
        .update(automationRuns)
        .set({ state: 'interrupted', updatedAt: this.now() })
        .where(and(eq(automationRuns.channelId, target.channelId), eq(automationRuns.state, 'queued')))
      return binding
    })
  }

  /** Stops future delivery immediately. An already submitted network message cannot be recalled. */
  async disable(channelId: string, expectedVersion: number): Promise<void> {
    identifier(channelId)
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) fail('automation_invalid_version')
    const db = await this.getDatabase()
    await db.transaction(async (tx) => {
      const rows = await tx
        .update(automationBindings)
        .set({ enabled: false, updatedAt: this.now() })
        .where(and(eq(automationBindings.channelId, channelId), eq(automationBindings.version, expectedVersion)))
        .returning({ id: automationBindings.channelId })
      if (!rows.length) fail('automation_binding_changed')
      await tx
        .update(automationOutbox)
        .set({ state: 'cancelled', reason: 'sync_disabled', updatedAt: this.now() })
        .where(and(eq(automationOutbox.channelId, channelId), inArray(automationOutbox.state, mutableDeliveryStates)))
      await tx
        .update(automationRuns)
        .set({ state: 'interrupted', updatedAt: this.now() })
        .where(and(eq(automationRuns.channelId, channelId), eq(automationRuns.state, 'queued')))
    })
  }

  async acceptMessage(target: AutomationTarget, messageId: string, origin: 'wechat' | 'desktop', input: string) {
    identifier(messageId)
    text(input)
    if (!['wechat', 'desktop'].includes(origin)) fail('automation_invalid_origin')
    const db = await this.getDatabase()
    return db.transaction(async (tx) => {
      const binding = await authorizedBinding(tx, target.channelId)
      if (!sameTarget(binding, target)) fail('automation_binding_changed')
      const sourceKey = key([origin, target.channelId, target.accountId, target.peerId, messageId])
      const [existing] = await tx.select().from(automationRuns).where(eq(automationRuns.sourceKey, sourceKey))
      if (existing) return { run: existing, duplicate: true }
      const [queued] = await tx
        .select({ total: count() })
        .from(automationRuns)
        .where(and(eq(automationRuns.channelId, target.channelId), eq(automationRuns.state, 'queued')))
      if (queued.total >= MAX_QUEUED_RUNS_PER_CHANNEL) fail('automation_queue_full')
      const [inserted] = await tx
        .insert(automationRuns)
        .values({
          id: randomUUID(),
          sourceKey,
          origin,
          channelId: target.channelId,
          bindingVersion: target.version,
          sessionId: target.sessionId,
          state: 'queued',
          input,
          createdAt: this.now(),
          updatedAt: this.now()
        })
        .onConflictDoNothing({ target: automationRuns.sourceKey })
        .returning()
      const run = inserted ?? (await tx.select().from(automationRuns).where(eq(automationRuns.sourceKey, sourceKey)))[0]
      return { run, duplicate: !inserted }
    })
  }

  async claimRun(id: string) {
    identifier(id)
    const db = await this.getDatabase()
    return db.transaction(async (tx) => {
      const [run] = await tx.select().from(automationRuns).where(eq(automationRuns.id, id))
      if (!run || run.state !== 'queued') return undefined
      const binding = await authorizedBinding(tx, run.channelId)
      if (!binding?.enabled || binding.version !== run.bindingVersion || binding.sessionId !== run.sessionId)
        fail('automation_binding_changed')
      // SQLite insertion order is monotonic even if the local clock moves backwards.
      const [first] = await tx
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(and(eq(automationRuns.sessionId, run.sessionId), eq(automationRuns.state, 'queued')))
        .orderBy(asc(sql`${automationRuns}.rowid`))
        .limit(1)
      if (first?.id !== id) return undefined
      const [active] = await tx
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(and(eq(automationRuns.sessionId, run.sessionId), eq(automationRuns.state, 'running')))
      if (active) return undefined
      return (
        await tx
          .update(automationRuns)
          .set({ state: 'running', updatedAt: this.now() })
          .where(and(eq(automationRuns.id, id), eq(automationRuns.state, 'queued')))
          .returning()
      )[0]
    })
  }

  /** Stores the immutable result and its text outbox together; never sends on this path. */
  async completeRun(id: string, answer: string): Promise<void> {
    identifier(id)
    text(answer)
    const db = await this.getDatabase()
    await db.transaction(async (tx) => {
      const [run] = await tx.select().from(automationRuns).where(eq(automationRuns.id, id))
      if (!run) fail('automation_run_missing')
      if (run.state === 'completed' && run.result === answer) return
      if (run.state !== 'running') fail('automation_run_not_running')
      const binding = await authorizedBinding(tx, run.channelId)
      await tx
        .update(automationRuns)
        .set({ state: 'completed', result: answer, updatedAt: this.now() })
        .where(eq(automationRuns.id, id))
      if (!binding?.enabled || binding.version !== run.bindingVersion || binding.sessionId !== run.sessionId) return
      const parts = [
        ...(run.origin === 'desktop'
          ? splitAutomationText(run.input).map((part) => ({ role: 'user' as const, text: part }))
          : []),
        ...splitAutomationText(answer).map((part) => ({ role: 'assistant' as const, text: part }))
      ]
      await tx.insert(automationOutbox).values(
        parts.map((part, sequence) => ({
          ...part,
          deliveryKey: key([id, String(sequence)]),
          runId: id,
          channelId: binding.channelId,
          accountId: binding.accountId,
          peerId: binding.peerId,
          sessionId: binding.sessionId,
          bindingVersion: binding.version,
          state: 'pending' as const,
          nextAttemptAt: this.now(),
          expiresAt: this.now() + DELIVERY_TTL_MS,
          createdAt: this.now(),
          updatedAt: this.now()
        }))
      )
    })
  }

  /** Last-resort local completion when outbox creation failed after native history was saved. */
  async preserveCompletedResult(id: string, answer: string): Promise<void> {
    identifier(id)
    const db = await this.getDatabase()
    await db
      .update(automationRuns)
      .set({ state: 'completed', result: answer.slice(0, 24_000), updatedAt: this.now() })
      .where(and(eq(automationRuns.id, id), eq(automationRuns.state, 'running')))
  }

  async endRun(id: string, state: 'failed' | 'stopped'): Promise<void> {
    identifier(id)
    if (!['failed', 'stopped'].includes(state)) fail('automation_invalid_run_state')
    const db = await this.getDatabase()
    await db
      .update(automationRuns)
      .set({ state, updatedAt: this.now() })
      .where(and(eq(automationRuns.id, id), inArray(automationRuns.state, ['queued', 'running'])))
  }

  async claimDelivery(channelId: string): Promise<AutomationDelivery | undefined> {
    identifier(channelId)
    const db = await this.getDatabase()
    return db.transaction(async (tx) => {
      const [item] = await tx
        .select()
        .from(automationOutbox)
        .where(
          and(eq(automationOutbox.channelId, channelId), notInArray(automationOutbox.state, ['accepted', 'cancelled']))
        )
        .orderBy(asc(automationOutbox.id))
        .limit(1)
      if (!item) return undefined
      // In-flight cannot be recalled. All other expired parts must eventually release the queue.
      if (item.state === 'sending') return undefined
      const binding = await authorizedBinding(tx, channelId)
      if (!sameTarget(binding, deliveryTarget(item)) || item.expiresAt <= this.now()) {
        await tx
          .update(automationOutbox)
          .set({ state: 'cancelled', reason: 'binding_or_delivery_expired', updatedAt: this.now() })
          .where(eq(automationOutbox.id, item.id))
        return undefined
      }
      // Unknown/failed first parts block later parts until a user decision or expiration.
      if (!['pending', 'retry_wait'].includes(item.state)) return undefined
      if (item.nextAttemptAt > this.now()) return undefined
      return (
        await tx
          .update(automationOutbox)
          .set({ state: 'sending', lease: randomUUID(), attempts: item.attempts + 1, updatedAt: this.now() })
          .where(and(eq(automationOutbox.id, item.id), eq(automationOutbox.state, item.state)))
          .returning()
      )[0]
    })
  }

  async settleDelivery(id: number, lease: string, outcome: DeliveryOutcome): Promise<boolean> {
    if (!Number.isSafeInteger(id) || id < 1) fail('automation_invalid_delivery')
    identifier(lease)
    if (!['accepted', 'retryable', 'failed', 'unknown'].includes(outcome.status)) fail('automation_invalid_outcome')
    if (outcome.status !== 'accepted' && !/^[a-z0-9_.-]{1,64}$/.test(outcome.reason)) fail('automation_invalid_reason')
    const db = await this.getDatabase()
    return db.transaction(async (tx) => {
      const [item] = await tx
        .select()
        .from(automationOutbox)
        .where(
          and(eq(automationOutbox.id, id), eq(automationOutbox.state, 'sending'), eq(automationOutbox.lease, lease))
        )
      if (!item) return false
      const binding = await authorizedBinding(tx, item.channelId)
      const canRetry =
        sameTarget(binding, deliveryTarget(item)) &&
        item.attempts < MAX_DELIVERY_ATTEMPTS &&
        item.expiresAt > this.now()
      await tx
        .update(automationOutbox)
        .set({
          state:
            outcome.status === 'accepted'
              ? 'accepted'
              : outcome.status === 'retryable'
                ? canRetry
                  ? 'retry_wait'
                  : 'failed'
                : outcome.status,
          reason: outcome.status === 'accepted' ? null : outcome.reason,
          lease: null,
          nextAttemptAt: this.now() + Math.min(60_000, 1000 * 2 ** (item.attempts - 1)),
          updatedAt: this.now()
        })
        .where(and(eq(automationOutbox.id, id), eq(automationOutbox.lease, lease)))
      return true
    })
  }

  /** Safe startup recovery: never restart a model task or blindly resend an uncertain message. */
  async recoverInterrupted(): Promise<void> {
    const db = await this.getDatabase()
    await db.transaction(async (tx) => {
      await tx
        .update(automationRuns)
        .set({ state: 'interrupted', updatedAt: this.now() })
        .where(inArray(automationRuns.state, ['queued', 'running']))
      await tx
        .update(automationOutbox)
        .set({ state: 'unknown', lease: null, reason: 'process_interrupted', updatedAt: this.now() })
        .where(eq(automationOutbox.state, 'sending'))
    })
  }

  /** Compact redundant delivery bodies, not the user's history or generated files; retain dedup identities. */
  async compactDeliveredHistory(): Promise<void> {
    const db = await this.getDatabase()
    const cutoff = this.now() - 30 * 24 * 60 * 60_000
    await db.transaction(async (tx) => {
      const old = tx
        .select({ id: automationOutbox.id })
        .from(automationOutbox)
        .where(and(lt(automationOutbox.createdAt, cutoff), inArray(automationOutbox.state, ['accepted', 'cancelled'])))
      await tx.delete(automationFiles).where(inArray(automationFiles.deliveryId, old))
      await tx.update(automationOutbox).set({ text: '' }).where(inArray(automationOutbox.id, old))
      await tx
        .update(automationRuns)
        .set({ input: '', result: null })
        .where(
          and(
            lt(automationRuns.createdAt, cutoff),
            inArray(automationRuns.state, ['completed', 'failed', 'stopped', 'interrupted'])
          )
        )
    })
  }
}
