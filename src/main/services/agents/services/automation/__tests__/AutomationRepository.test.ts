import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { type Client, createClient } from '@libsql/client'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { drizzle } from 'drizzle-orm/libsql'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '../../../database/schema'
import { automationOutbox, automationRuns } from '../../../database/schema'
import { acquireAssistantDataOperation } from '../../dataOperationGate'
import { AutomationOutbox } from '../AutomationOutbox'
import { AutomationRepository, type DeliveryOutcome, splitAutomationText } from '../AutomationRepository'

vi.unmock('node:fs')
vi.unmock('node:path')
vi.unmock('node:os')

const migration = fs.readFileSync(path.resolve('resources/database/drizzle/0009_assistant_automation.sql'), 'utf8')
const settingsMigration = fs.readFileSync(
  path.resolve('resources/database/drizzle/0010_assistant_automation_settings.sql'),
  'utf8'
)
const identity = { channelId: 'channel', accountId: 'account', peerId: 'peer', sessionId: 'session' }

describe('durable new-assistant automation perimeter', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let repository: AutomationRepository
  let now: number
  const temporaryDatabases: string[] = []

  async function initialize(url = 'file::memory:?cache=shared') {
    // Transactions lease another connection; shared memory keeps the test schema visible.
    client = createClient({ url })
    db = drizzle(client, { schema })
    await client.executeMultiple(`
      DROP TABLE IF EXISTS assistant_automation_outbox;
      DROP TABLE IF EXISTS assistant_automation_runs;
      DROP TABLE IF EXISTS assistant_automation_bindings;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS channels;
      CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY, agent_id text);
      CREATE TABLE IF NOT EXISTS channels (id text PRIMARY KEY, agent_id text, type text, is_active integer);
    `)
    await client.executeMultiple(migration)
    await client.executeMultiple(settingsMigration)
    await client.execute('DELETE FROM assistant_automation_files')
    await client.batch(
      [
        { sql: 'INSERT OR IGNORE INTO sessions VALUES (?, ?)', args: ['session', DEFAULT_OPENCODE_AGENT_ID] },
        { sql: 'INSERT OR IGNORE INTO sessions VALUES (?, ?)', args: ['session-2', DEFAULT_OPENCODE_AGENT_ID] },
        {
          sql: 'INSERT OR IGNORE INTO channels VALUES (?, ?, ?, 1)',
          args: ['channel', DEFAULT_OPENCODE_AGENT_ID, 'wechat']
        }
      ],
      'write'
    )
    repository = new AutomationRepository(
      async () => db,
      () => now
    )
  }

  beforeEach(async () => {
    now = 1_000_000
    await initialize()
    await repository.bind(identity, 0)
  })

  afterEach(() => {
    vi.useRealTimers()
    client.close()
    for (const directory of temporaryDatabases.splice(0)) {
      if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('zen-automation-'))
        throw new Error('Invalid temporary database directory')
      for (const name of ['automation.db', 'automation.db-wal', 'automation.db-shm']) {
        const file = path.join(directory, name)
        if (fs.existsSync(file)) fs.unlinkSync(file)
      }
      fs.rmdirSync(directory)
    }
  })

  const binding = () => ({ ...identity, version: 1 })
  async function accept(messageId = 'message', origin: 'wechat' | 'desktop' = 'wechat', input = '你好') {
    return repository.acceptMessage(binding(), messageId, origin, input)
  }
  async function complete(answer = '你好，我能帮你什么？', origin: 'wechat' | 'desktop' = 'wechat') {
    const { run } = await accept('message', origin)
    await repository.claimRun(run.id)
    await repository.completeRun(run.id, answer)
    return run
  }
  const deliveries = () => db.select().from(automationOutbox)
  const runs = () => db.select().from(automationRuns)

  it('delivers immutable file manifests after text, never through the text transport', async () => {
    const run = await complete()
    const file = { path: '/owned/output.docx', sha256: 'a'.repeat(64), size: 100 }
    await repository.enqueueFile(run.id, file)
    await repository.enqueueFile(run.id, file)
    expect(await deliveries()).toHaveLength(2)
    const sendText = vi.fn(async () => ({ status: 'accepted' as const }))
    const sendFile = vi.fn(async () => ({ status: 'accepted' as const }))
    const outbox = new AutomationOutbox(repository)
    await outbox.dispatchNext('channel', { accountId: 'account', sendText, sendFile })
    await outbox.dispatchNext('channel', { accountId: 'account', sendText, sendFile })
    expect(sendText).toHaveBeenCalledOnce()
    expect(sendFile).toHaveBeenCalledWith(expect.objectContaining(file), expect.any(AbortSignal))
    expect((await deliveries()).every((item) => item.state === 'accepted')).toBe(true)
  })

  it('manual resend preserves the stable part ID and expired unknown parts do not block forever', async () => {
    await complete()
    const item = (await repository.claimDelivery('channel'))!
    await repository.settleDelivery(item.id, item.lease!, { status: 'unknown', reason: 'timeout' })
    await repository.resolveDelivery(item.id, 'retry')
    const retried = (await repository.claimDelivery('channel'))!
    expect(retried.deliveryKey).toBe(item.deliveryKey)
    await repository.settleDelivery(retried.id, retried.lease!, { status: 'unknown', reason: 'timeout' })
    now += 6 * 60 * 60_000 + 1
    expect(await repository.claimDelivery('channel')).toBeUndefined()
    expect((await deliveries())[0].state).toBe('cancelled')
  })

  it('compacts old delivery bodies but keeps incoming dedup identities and user history untouched', async () => {
    await complete()
    const outbox = new AutomationOutbox(repository)
    await outbox.dispatchNext('channel', { accountId: 'account', sendText: async () => ({ status: 'accepted' }) })
    now += 31 * 24 * 60 * 60_000
    await repository.compactDeliveredHistory()
    expect((await deliveries())[0].text).toBe('')
    expect((await accept()).duplicate).toBe(true)
    expect((await client.execute('SELECT COUNT(*) AS count FROM sessions')).rows[0].count).toBe(2)
  })

  it('adds tables idempotently without changing existing sessions or channels', async () => {
    await client.executeMultiple(migration)
    expect((await client.execute('SELECT * FROM sessions')).rows).toHaveLength(2)
    expect((await client.execute('SELECT * FROM channels')).rows).toHaveLength(1)
    expect((await repository.getBinding('channel'))?.version).toBe(1)
  })

  it('rejects legacy ownership and unknown conversations before creating a binding', async () => {
    await client.execute({ sql: 'UPDATE sessions SET agent_id = ? WHERE id = ?', args: ['legacy', 'session-2'] })
    await expect(repository.bind({ ...identity, sessionId: 'session-2' }, 1)).rejects.toMatchObject({
      code: 'automation_invalid_owner'
    })
    await expect(repository.bind({ ...identity, channelId: 'missing' }, 0)).rejects.toMatchObject({
      code: 'automation_invalid_owner'
    })
    expect((await repository.getBinding('channel'))?.version).toBe(1)
  })

  it('requires a current binding version when switching conversations', async () => {
    await expect(repository.bind({ ...identity, sessionId: 'session-2' }, 0)).rejects.toMatchObject({
      code: 'automation_binding_changed'
    })
    const next = await repository.bind({ ...identity, sessionId: 'session-2' }, 1)
    expect(next.version).toBe(2)
    await expect(accept()).rejects.toMatchObject({ code: 'automation_binding_changed' })
  })

  it('does not authorize the same WeChat peer or conversation through two connections', async () => {
    await client.execute({
      sql: 'INSERT INTO channels VALUES (?, ?, ?, 1)',
      args: ['channel-2', DEFAULT_OPENCODE_AGENT_ID, 'wechat']
    })
    await expect(repository.bind({ ...identity, channelId: 'channel-2', sessionId: 'session-2' }, 0)).rejects.toThrow()
    await expect(repository.bind({ ...identity, channelId: 'channel-2', peerId: 'peer-2' }, 0)).rejects.toThrow()
    expect(await repository.getBinding('channel-2')).toBeUndefined()
    expect(await repository.getBinding('channel')).toMatchObject(binding())
  })

  it.each([
    "DELETE FROM sessions WHERE id = 'session'",
    "DELETE FROM channels WHERE id = 'channel'",
    "UPDATE channels SET is_active = 0 WHERE id = 'channel'",
    "UPDATE sessions SET agent_id = 'legacy' WHERE id = 'session'"
  ])('invalidates delivery when the authorized owner disappears: %s', async (sql) => {
    await complete()
    await client.execute(sql)
    expect(await repository.isCurrentTarget(binding())).toBe(false)
    await expect(accept('next')).rejects.toMatchObject({ code: 'automation_binding_changed' })
    expect(await repository.claimDelivery('channel')).toBeUndefined()
    expect((await deliveries())[0].state).toBe('cancelled')
  })

  it('bounds queued messages without rejecting an existing duplicate or losing its identity', async () => {
    for (let index = 0; index < 16; index++) await accept(`message-${index}`)
    expect((await accept('message-0')).duplicate).toBe(true)
    await expect(accept('overflow')).rejects.toMatchObject({ code: 'automation_queue_full' })
    expect(await runs()).toHaveLength(16)
  })

  it.each(['accountId', 'peerId', 'sessionId'] as const)('never accepts a mismatched %s', async (field) => {
    await expect(
      repository.acceptMessage({ ...binding(), [field]: 'wrong' }, 'm', 'wechat', '你好')
    ).rejects.toMatchObject({ code: 'automation_binding_changed' })
    expect(await runs()).toHaveLength(0)
  })

  it('rejects invalid identifiers, blank text, huge text and unsupported origins', async () => {
    await expect(repository.bind({ ...identity, peerId: '' }, 1)).rejects.toThrow()
    await expect(repository.bind(identity, Number.NaN)).rejects.toThrow()
    await expect(accept('')).rejects.toThrow()
    await expect(accept('x', 'wechat', '  ')).rejects.toThrow()
    await expect(accept('x', 'wechat', 'a'.repeat(1024 * 1024 + 1))).rejects.toThrow()
    await expect(repository.acceptMessage(binding(), 'x', 'scheduled' as any, 'text')).rejects.toThrow()
    expect(await runs()).toHaveLength(0)
  })

  it('deduplicates message IDs, not repeated text', async () => {
    const first = await accept('m1', 'wechat', '继续')
    expect((await accept('m1', 'wechat', '继续')).duplicate).toBe(true)
    const second = await accept('m2', 'wechat', '继续')
    expect(second.duplicate).toBe(false)
    expect(second.run.id).not.toBe(first.run.id)
    expect(await runs()).toHaveLength(2)
  })

  it('separates desktop message identity from WeChat message identity', async () => {
    await accept('same', 'wechat')
    await accept('same', 'desktop')
    expect(await runs()).toHaveLength(2)
  })

  it('claims each run once and allows only one running turn per conversation', async () => {
    const first = await accept('first')
    const second = await accept('second')
    expect(await repository.claimRun(first.run.id)).toMatchObject({ state: 'running' })
    expect(await repository.claimRun(first.run.id)).toBeUndefined()
    expect(await repository.claimRun(second.run.id)).toBeUndefined()
    await repository.completeRun(first.run.id, '完成')
    expect(await repository.claimRun(second.run.id)).toMatchObject({ state: 'running' })
  })

  it('does not start a later queued question ahead of an earlier question after a clock change', async () => {
    const first = await accept('first')
    now -= 100_000
    const second = await accept('second')
    expect(await repository.claimRun(second.run.id)).toBeUndefined()
    expect(await repository.claimRun(first.run.id)).toMatchObject({ state: 'running' })
    await repository.completeRun(first.run.id, 'first answer')
    expect(await repository.claimRun(second.run.id)).toMatchObject({ state: 'running' })
  })

  it('refuses to rebind a running conversation', async () => {
    const { run } = await accept()
    await repository.claimRun(run.id)
    await expect(repository.bind({ ...identity, accountId: 'new-account' }, 1)).rejects.toMatchObject({
      code: 'automation_binding_busy'
    })
  })

  it('commits one immutable answer and outbox without sending or echoing the incoming question', async () => {
    const run = await complete()
    await repository.completeRun(run.id, '你好，我能帮你什么？')
    expect(await deliveries()).toHaveLength(1)
    expect((await deliveries())[0]).toMatchObject({
      role: 'assistant',
      state: 'pending',
      accountId: 'account',
      peerId: 'peer'
    })
    await expect(repository.completeRun(run.id, 'different')).rejects.toThrow()
    expect((await runs())[0]).toMatchObject({ state: 'completed', result: '你好，我能帮你什么？' })
  })

  it('mirrors only this desktop exchange with user-before-answer order', async () => {
    await complete('更正式的版本', 'desktop')
    expect((await deliveries()).map((item) => [item.role, item.text])).toEqual([
      ['user', '你好'],
      ['assistant', '更正式的版本']
    ])
  })

  it('does not complete an unclaimed or empty model result', async () => {
    const { run } = await accept()
    await expect(repository.completeRun(run.id, 'answer')).rejects.toThrow()
    await repository.claimRun(run.id)
    await expect(repository.completeRun(run.id, '')).rejects.toThrow()
    expect(await deliveries()).toHaveLength(0)
    expect((await runs())[0].state).toBe('running')
  })

  it('rolls back completion if its outbox cannot be saved', async () => {
    const { run } = await accept()
    await repository.claimRun(run.id)
    await client.executeMultiple(`
      CREATE TRIGGER reject_delivery BEFORE INSERT ON assistant_automation_outbox
      BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;
    `)
    await expect(repository.completeRun(run.id, 'answer')).rejects.toThrow()
    expect((await runs())[0]).toMatchObject({ state: 'running', result: null })
    expect(await deliveries()).toHaveLength(0)
    await client.execute('DROP TRIGGER reject_delivery')
    await repository.completeRun(run.id, 'answer')
    expect((await deliveries())[0].state).toBe('pending')
  })

  it('stores allowed-size desktop text without mixing presentation wrappers into message content', async () => {
    const { run } = await accept('large', 'desktop', 'a'.repeat(1024 * 1024))
    await repository.claimRun(run.id)
    await repository.completeRun(run.id, 'answer')
    const outgoing = await deliveries()
    expect(
      outgoing
        .filter((part) => part.role === 'user')
        .map((part) => part.text)
        .join('')
    ).toBe(run.input)
    expect(outgoing.every((part) => Array.from(part.text).length <= 1800)).toBe(true)
  })

  it('keeps a locally completed answer but never queues it after synchronization is disabled', async () => {
    const { run } = await accept()
    await repository.claimRun(run.id)
    await repository.disable('channel', 1)
    await repository.completeRun(run.id, '已保存在电脑')
    expect((await runs())[0].state).toBe('completed')
    expect(await deliveries()).toHaveLength(0)
    await expect(accept('next')).rejects.toThrow()
  })

  it('invalidates queued inputs and old outbox on account change rather than retargeting them', async () => {
    await complete()
    await accept('queued')
    await repository.bind({ ...identity, accountId: 'new-account', peerId: 'new-peer' }, 1)
    expect((await deliveries())[0]).toMatchObject({ state: 'cancelled', accountId: 'account', peerId: 'peer' })
    expect((await runs()).find((run) => run.state === 'interrupted')).toBeDefined()
    expect(await repository.claimDelivery('channel')).toBeUndefined()
  })

  it('leases a delivery once and fences stale acknowledgements', async () => {
    await complete()
    const item = await repository.claimDelivery('channel')
    expect(item).toMatchObject({ state: 'sending', attempts: 1 })
    expect(await repository.claimDelivery('channel')).toBeUndefined()
    expect(await repository.settleDelivery(item!.id, 'wrong-lease', { status: 'accepted' })).toBe(false)
    expect(await repository.settleDelivery(item!.id, item!.lease!, { status: 'accepted' })).toBe(true)
    expect(await repository.settleDelivery(item!.id, item!.lease!, { status: 'accepted' })).toBe(false)
    expect(await repository.claimDelivery('channel')).toBeUndefined()
  })

  it('refuses account switching while a delivery is in flight', async () => {
    await complete()
    await repository.claimDelivery('channel')
    await expect(repository.bind({ ...identity, accountId: 'new-account' }, 1)).rejects.toMatchObject({
      code: 'automation_binding_busy'
    })
  })

  it('retries only the unsent segment and stops after three attempts', async () => {
    await complete('😀'.repeat(950))
    const first = (await repository.claimDelivery('channel'))!
    await repository.settleDelivery(first.id, first.lease!, { status: 'accepted' })
    let second = (await repository.claimDelivery('channel'))!
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(second.id).not.toBe(first.id)
      expect(second.attempts).toBe(attempt)
      await repository.settleDelivery(second.id, second.lease!, {
        status: 'retryable',
        reason: 'temporarily_unavailable'
      })
      expect(await repository.claimDelivery('channel')).toBeUndefined()
      now += 60_000
      if (attempt < 3) second = (await repository.claimDelivery('channel'))!
    }
    expect((await deliveries()).map((item) => item.state)).toEqual(['accepted', 'failed'])
    expect(await repository.claimDelivery('channel')).toBeUndefined()
    expect(await runs()).toHaveLength(1)
  })

  it.each(['unknown', 'failed'] as const)(
    'does not automatically resend a %s message or skip ahead',
    async (status) => {
      await complete('answer', 'desktop')
      const item = (await repository.claimDelivery('channel'))!
      await repository.settleDelivery(item.id, item.lease!, { status, reason: 'delivery_unconfirmed' })
      now += 60_000
      expect(await repository.claimDelivery('channel')).toBeUndefined()
      expect((await deliveries())[1].attempts).toBe(0)
    }
  )

  it('does not send expired results', async () => {
    await complete()
    now += 7 * 60 * 60_000
    expect(await repository.claimDelivery('channel')).toBeUndefined()
    expect((await deliveries())[0].state).toBe('cancelled')
  })

  it('marks interrupted execution and uncertain sending without replaying either', async () => {
    await complete()
    await repository.claimDelivery('channel')
    const { run } = await accept('in-flight')
    await repository.claimRun(run.id)
    await repository.recoverInterrupted()
    expect((await runs()).find((item) => item.id === run.id)?.state).toBe('interrupted')
    expect((await deliveries())[0]).toMatchObject({ state: 'unknown', lease: null })
    expect(await repository.claimRun(run.id)).toBeUndefined()
    expect(await repository.claimDelivery('channel')).toBeUndefined()
  })

  it('never changes a completed result when stopped or failed after delivery', async () => {
    const run = await complete()
    await repository.endRun(run.id, 'failed')
    await repository.endRun(run.id, 'stopped')
    expect((await runs())[0].state).toBe('completed')
  })

  it('preserves identity, deduplication and unsent results after closing and reopening the actual database', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-automation-'))
    temporaryDatabases.push(directory)
    const url = `file:${path.join(directory, 'automation.db')}`
    // Separate processes exercise real restart durability and release Windows native handles.
    const setup = `
      const { createClient } = require('@libsql/client');
      const { drizzle } = require('drizzle-orm/libsql');
      const schema = require('./src/main/services/agents/database/schema/index.ts');
      const { AutomationRepository } = require('./src/main/services/agents/services/automation/AutomationRepository.ts');
      const client = createClient({url: ${JSON.stringify(url)}});
      const db = drizzle(client, {schema});
      const repo = new AutomationRepository(async () => db);
      const identity = ${JSON.stringify(identity)};
      const target = {...identity, version: 1};
    `
    const execute = async (body: string) => {
      const result = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          '-e',
          `
        (async () => { ${setup} try { ${body} } finally { client.close(); } })()
          .catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
      `
        ],
        { timeout: 10_000, env: { ...process.env, TSX_TSCONFIG_PATH: path.resolve('tsconfig.node.json') } }
      )
      return JSON.parse(result.stdout)
    }
    const saved = await execute(`
      await client.executeMultiple('CREATE TABLE sessions (id text PRIMARY KEY, agent_id text); CREATE TABLE channels (id text PRIMARY KEY, agent_id text, type text, is_active integer);');
      await client.executeMultiple(${JSON.stringify(migration)});
      await client.execute({sql: 'INSERT INTO sessions VALUES (?, ?)', args:['session', ${JSON.stringify(DEFAULT_OPENCODE_AGENT_ID)}]});
      await client.execute({sql: 'INSERT INTO channels VALUES (?, ?, ?, 1)', args:['channel', ${JSON.stringify(DEFAULT_OPENCODE_AGENT_ID)}, 'wechat']});
      await repo.bind(identity, 0);
      const {run} = await repo.acceptMessage(target, 'message', 'wechat', '你好');
      await repo.claimRun(run.id);
      await repo.completeRun(run.id, '保存的回答');
      process.stdout.write(JSON.stringify({runId:run.id}));
    `)
    const reopened = await execute(`
      const receipt = await repo.acceptMessage(target, 'message', 'wechat', '你好');
      const outbox = await db.select().from(schema.automationOutbox);
      process.stdout.write(JSON.stringify({binding:await repo.getBinding('channel'), receipt, outbox}));
    `)
    expect(reopened.binding).toMatchObject(binding())
    expect(reopened.receipt.duplicate).toBe(true)
    expect(reopened.receipt.run.id).toBe(saved.runId)
    expect(reopened.outbox[0]).toMatchObject({ state: 'pending', text: '保存的回答' })
  }, 25_000)

  it('does not access the repository during a backup, restore or reset', async () => {
    const lock = acquireAssistantDataOperation('restore', () => false)
    try {
      await expect(accept()).rejects.toMatchObject({ code: 'assistant_data_busy' })
      await expect(repository.claimDelivery('channel')).rejects.toMatchObject({ code: 'assistant_data_busy' })
    } finally {
      lock.release()
    }
    expect(await runs()).toHaveLength(0)
  })

  it('splits Unicode text without dropping or splitting surrogate pairs', () => {
    const original = '你好😀abc'.repeat(1000)
    const chunks = splitAutomationText(original)
    expect(chunks.join('')).toBe(original)
    expect(chunks.every((part) => part.length <= 1800)).toBe(true)
    expect(chunks.every((part) => !/[\uD800-\uDBFF]$/.test(part))).toBe(true)
    expect(() => splitAutomationText(original, 0)).toThrow()
  })

  describe('bounded text delivery without model calls', () => {
    it('delivers only to the snapshotted account, peer and session', async () => {
      await complete()
      const sendText = vi.fn().mockResolvedValue({ status: 'accepted' })
      const outbox = new AutomationOutbox(repository)
      expect(await outbox.dispatchNext('channel', { accountId: 'account', sendText })).toBe(true)
      expect(sendText).toHaveBeenCalledWith(
        {
          target: binding(),
          runId: expect.any(String),
          deliveryKey: expect.any(String),
          role: 'assistant',
          text: '你好，我能帮你什么？'
        },
        expect.any(AbortSignal)
      )
      expect((await deliveries())[0].state).toBe('accepted')
      expect(await outbox.dispatchNext('channel', { accountId: 'account', sendText })).toBe(false)
      expect(sendText).toHaveBeenCalledOnce()
    })

    it('never sends through a transport logged in as another account', async () => {
      await complete()
      const sendText = vi.fn()
      await new AutomationOutbox(repository).dispatchNext('channel', { accountId: 'different-account', sendText })
      expect(sendText).not.toHaveBeenCalled()
      expect((await deliveries())[0]).toMatchObject({ state: 'failed', reason: 'account_changed' })
    })

    it('does not retry ambiguous transport exceptions', async () => {
      await complete()
      const sendText = vi.fn().mockRejectedValue(new Error('secret upstream message'))
      const outbox = new AutomationOutbox(repository)
      await outbox.dispatchNext('channel', { accountId: 'account', sendText })
      expect((await deliveries())[0]).toMatchObject({ state: 'unknown', reason: 'transport_exception' })
      await outbox.dispatchNext('channel', { accountId: 'account', sendText })
      expect(sendText).toHaveBeenCalledOnce()
    })

    it.each([undefined, { status: 'failed', reason: 'token=secret' }, { status: 'made-up' }])(
      'records an invalid transport response as unknown without leaking raw details: %j',
      async (response) => {
        await complete()
        const sendText = vi.fn().mockResolvedValue(response)
        await new AutomationOutbox(repository).dispatchNext('channel', { accountId: 'account', sendText })
        expect((await deliveries())[0]).toMatchObject({ state: 'unknown', reason: 'invalid_transport_result' })
      }
    )

    it('does not start a cancelled delivery', async () => {
      await complete()
      const controller = new AbortController()
      controller.abort()
      const sendText = vi.fn()
      await new AutomationOutbox(repository).dispatchNext(
        'channel',
        { accountId: 'account', sendText },
        controller.signal
      )
      expect(sendText).not.toHaveBeenCalled()
      expect((await deliveries())[0].attempts).toBe(0)
    })

    it('marks an in-flight cancellation as unknown and fences a late successful response', async () => {
      await complete()
      const controller = new AbortController()
      let finish: (outcome: DeliveryOutcome) => void = () => {}
      let started: () => void = () => {}
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      const sendText = vi.fn().mockImplementation(() => {
        started()
        return new Promise<DeliveryOutcome>((resolve) => {
          finish = resolve
        })
      })
      const outbox = new AutomationOutbox(repository)
      const request = outbox.dispatchNext('channel', { accountId: 'account', sendText }, controller.signal)
      await ready
      controller.abort()
      await request
      finish({ status: 'accepted' })
      await Promise.resolve()
      expect((await deliveries())[0]).toMatchObject({ state: 'unknown', reason: 'delivery_cancelled' })
      expect(await outbox.dispatchNext('channel', { accountId: 'account', sendText })).toBe(false)
      expect(sendText).toHaveBeenCalledOnce()
    })

    it('bounds a hung transport and keeps the result unknown rather than resending', async () => {
      await complete()
      vi.useFakeTimers()
      const sendText = vi.fn().mockImplementation((_request, signal: AbortSignal) => {
        return new Promise<DeliveryOutcome>((resolve) => {
          signal.addEventListener('abort', () => resolve({ status: 'unknown', reason: 'aborted' }))
        })
      })
      const outbox = new AutomationOutbox(repository, 50)
      const pending = outbox.dispatchNext('channel', { accountId: 'account', sendText })
      // Let SQLite promises settle before advancing the timeout owned by the dispatcher.
      await vi.waitFor(() => expect(sendText).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(50)
      await pending
      expect((await deliveries())[0]).toMatchObject({ state: 'unknown', reason: 'delivery_timeout' })
      expect(await outbox.dispatchNext('channel', { accountId: 'account', sendText })).toBe(false)
    })

    it('rejects invalid diagnostic reason strings instead of storing potentially sensitive transport errors', async () => {
      await complete()
      const item = (await repository.claimDelivery('channel'))!
      await expect(
        repository.settleDelivery(item.id, item.lease!, { status: 'failed', reason: 'apiKey=secret' })
      ).rejects.toThrow()
      expect((await deliveries())[0].reason).toBeNull()
    })
  })
})
