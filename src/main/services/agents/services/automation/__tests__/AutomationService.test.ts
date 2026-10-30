import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { type Client, createClient } from '@libsql/client'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { drizzle } from 'drizzle-orm/libsql'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: undefined as any,
  root: '',
  execute: vi.fn(),
  createSession: vi.fn(),
  login: vi.fn(),
  listen: vi.fn(),
  botOptions: undefined as any,
  getSession: vi.fn(),
  persist: vi.fn(),
  developer: false
}))
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')
vi.mock('../../../BaseService', () => ({
  BaseService: class {
    getDatabase() {
      return Promise.resolve(mocks.db)
    }
  }
}))
vi.mock('@main/utils', () => ({ getDataPath: (name: string) => path.join(mocks.root, name) }))
vi.mock('@main/apiServer/services/models', () => ({
  modelsService: { getModels: async () => ({ data: [{ id: 'zen:model', name: 'test model' }] }) }
}))
vi.mock('@main/services/ApiServerService', () => ({ apiServerService: { isRunning: () => true, start: vi.fn() } }))
vi.mock('@main/services/ConfigManager', () => ({
  configManager: { getEnableDeveloperMode: () => mocks.developer, getLanguage: () => 'zh-CN' }
}))
vi.mock('@main/services/RemoteModelPolicyService', () => ({ remoteModelPolicyService: { getSnapshot: () => ({}) } }))
vi.mock('../../../../../../renderer/src/config/agentModelPolicy', () => ({
  resolveAssistantFallbackModel: (data: any[]) => data[0]
}))
vi.mock('../../opencode/builtin', () => ({ ensureOpenCodeAgent: async () => true }))
vi.mock('../../channels/sessionStreamIpc', () => ({ broadcastSessionChanged: vi.fn() }))
vi.mock('../../channels/SessionStreamBus', () => ({ sessionStreamBus: { publish: vi.fn() } }))
vi.mock('../../channels/adapters/wechat/WeChatProtocol', () => ({
  WeixinBot: class {
    constructor(options: unknown) {
      mocks.botOptions = options
    }
    login = mocks.login
    onMessage = vi.fn()
    run = mocks.listen
    stop = vi.fn()
  }
}))
vi.mock('../../SessionMessageService', () => ({ sessionMessageService: { createSessionMessage: mocks.execute } }))
vi.mock('../../../database/sessionMessageRepository', () => ({
  agentMessageRepository: { persistExchange: mocks.persist, persistAssistantMessage: mocks.persist }
}))
vi.mock('../../SessionService', () => ({
  sessionService: {
    getSession: mocks.getSession,
    createSession: mocks.createSession,
    reconcileManagedModels: vi.fn(async () => {})
  }
}))
vi.mock('../../managedModelRecovery', () => ({
  getManagedRecoveryInventory: async () => ({ models: [], providers: [] }),
  resolveManagedSessionModel: (_slot: string, current: string) => ({ managed: false, selected: current })
}))

import * as schema from '../../../database/schema'
import { sessionStreamBus } from '../../channels/SessionStreamBus'
import { acquireSessionActivity } from '../../sessionActivity'
import { AutomationService } from '../AutomationService'
import { captureAutomationMirrorTarget, mirrorAutomationExchange, prepareAutomationSession } from '../bridge'
import { getAutomationProfile } from '../profile'

describe('new assistant automation orchestration (SQLite + simulated runtime, no external account)', () => {
  let client: Client
  let memoryAnchor: Client
  let service: AutomationService
  let internal: any
  let modelCalls: number
  const channelId = 'zen-opencode-wechat'
  const input = (id: string, text = '你好') => ({
    messageId: id,
    accountId: 'account',
    userId: 'owner',
    text,
    type: 'text',
    timestamp: new Date(),
    _contextToken: 'context'
  })
  beforeEach(async () => {
    vi.mocked(sessionStreamBus.publish).mockClear()
    mocks.login.mockReset().mockResolvedValue({ accountId: 'account', userId: 'owner' })
    mocks.listen.mockReset().mockResolvedValue(undefined)
    mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-automation-integration-'))
    const url = 'file::memory:?cache=shared'
    // libsql detaches its primary connection when leasing a transaction. Keep
    // a non-transactional anchor alive so GC cannot destroy the fixture schema.
    memoryAnchor = createClient({ url })
    await memoryAnchor.execute('SELECT 1')
    client = createClient({ url })
    await client.execute('PRAGMA foreign_keys=OFF')
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    for (const row of tables.rows) await client.execute(`DROP TABLE "${String(row.name).replaceAll('"', '""')}"`)
    for (const file of (await fs.readdir('resources/database/drizzle'))
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      await client.executeMultiple(await fs.readFile(path.join('resources/database/drizzle', file), 'utf8'))
    }
    mocks.db = drizzle(client, { schema })
    mocks.createSession.mockReset().mockImplementation(async (agentId, request) => {
      const session = {
        id: `created-${mocks.createSession.mock.calls.length}`,
        agent_id: agentId,
        agent_type: 'claude-code',
        ...request,
        created_at: 'now',
        updated_at: 'now'
      }
      // Preserve the real SessionService's NOT NULL contract. An undefined translated
      // name must fail here too, rather than a permissive mock hiding the login bug.
      await mocks.db.insert(schema.sessionsTable).values({
        ...session,
        name: request.name || null,
        accessible_paths: JSON.stringify(request.accessible_paths),
        configuration: JSON.stringify(request.configuration),
        mcps: JSON.stringify(request.mcps),
        allowed_tools: JSON.stringify(request.allowed_tools)
      })
      return session
    })
    await client.execute({
      sql: "INSERT INTO agents(id,type,name,model,created_at,updated_at) VALUES(?, 'claude-code','test','zen:model','now','now')",
      args: [DEFAULT_OPENCODE_AGENT_ID]
    })
    await mocks.db.insert(schema.sessionsTable).values({
      id: 'session',
      agent_id: DEFAULT_OPENCODE_AGENT_ID,
      agent_type: 'claude-code',
      name: 'WeChat',
      model: 'zen:model',
      created_at: 'now',
      updated_at: 'now'
    })
    await mocks.db.insert(schema.channelsTable).values({
      id: channelId,
      type: 'wechat',
      agentId: DEFAULT_OPENCODE_AGENT_ID,
      name: 'test',
      isActive: false,
      config: { type: 'wechat' }
    })
    const workspace = path.join(mocks.root, 'workspace')
    await fs.mkdir(workspace)
    await mocks.db
      .insert(schema.automationSessions)
      .values({ sessionId: 'session', workspace, kind: 'wechat', createdAt: Date.now() })
    service = new AutomationService()
    internal = service as any
    await service.start()
    await client.execute('UPDATE channels SET is_active=1')
    await service.repository.bind({ channelId, accountId: 'account', peerId: 'owner', sessionId: 'session' }, 0)
    internal.authenticated = { accountId: 'account', peerId: 'owner' }
    internal.deliveryBusy = true // Real transport has separate contract tests; retain queued parts for assertions.
    mocks.getSession.mockReset().mockResolvedValue({
      id: 'session',
      agent_id: DEFAULT_OPENCODE_AGENT_ID,
      model: 'zen:model',
      configuration: {},
      accessible_paths: [workspace]
    })
    mocks.persist.mockReset().mockResolvedValue({})
    modelCalls = 0
    mocks.execute.mockReset().mockImplementation(async (session, _request, _controller, options) => {
      const release = acquireSessionActivity(session.id, 'run', 1)
      try {
        await options.onAdmitted()
        modelCalls++
        const payload = { message: { providerMetadata: { zenAutomation: { finalText: 'Final answer' } } }, blocks: [] }
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.close()
            }
          }),
          completion: Promise.resolve({ assistantMessage: { content: payload } }).finally(release)
        }
      } catch (error) {
        release()
        throw error
      }
    })
  })
  afterEach(async () => {
    await service.stop()
    client.close()
    memoryAnchor.close()
    await fs.rm(mocks.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  async function settled() {
    await internal.tick()
    await vi.waitFor(() => expect(internal.active.size).toBe(0))
  }

  it('completes scanned login and explicit owner confirmation with a non-empty localized session name', async () => {
    expect(await service.request({ action: 'login' })).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(internal.connection.status).toBe('awaiting_confirmation'))
    expect(mocks.listen).not.toHaveBeenCalled()
    const result = await service.request({ action: 'confirm', authorized: true })
    expect(result).toMatchObject({
      ok: true,
      data: { connection: { status: 'connected', enabled: true, sessionId: 'created-1' } }
    })
    expect(mocks.createSession).toHaveBeenCalledWith(
      DEFAULT_OPENCODE_AGENT_ID,
      expect.objectContaining({ name: '微信会话', model: 'zen:model' })
    )
    expect((await client.execute({ sql: 'SELECT name FROM sessions WHERE id = ?', args: ['created-1'] })).rows).toEqual(
      [{ name: '微信会话' }]
    )
    expect(await service.repository.getBinding(channelId)).toMatchObject({
      accountId: 'account',
      peerId: 'owner',
      sessionId: 'created-1'
    })
    expect(mocks.listen).toHaveBeenCalledTimes(1)
    expect(modelCalls).toBe(0)
  })

  it('keeps confirmation pending after a local save failure, allowing retry without rescanning', async () => {
    await service.request({ action: 'login' })
    await vi.waitFor(() => expect(internal.connection.status).toBe('awaiting_confirmation'))
    mocks.createSession.mockRejectedValueOnce(new Error('SQLITE_BUSY: test database temporarily unavailable'))
    expect(await service.request({ action: 'confirm', authorized: true })).toMatchObject({
      ok: false,
      code: 'automation_operation_failed'
    })
    expect(internal.connection.status).toBe('awaiting_confirmation')
    expect(mocks.listen).not.toHaveBeenCalled()
    expect(await service.repository.getBinding(channelId)).toMatchObject({ sessionId: 'session' })
    expect(await service.request({ action: 'confirm', authorized: true })).toMatchObject({
      ok: true,
      data: { connection: { status: 'connected' } }
    })
    expect(mocks.login).toHaveBeenCalledTimes(1)
  })

  it('rejects owner confirmation before login and does not create any conversation', async () => {
    expect(await service.request({ action: 'confirm', authorized: true })).toMatchObject({
      ok: false,
      code: 'automation_login_not_ready'
    })
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.listen).not.toHaveBeenCalled()
  })

  it('creates subsequent WeChat conversations with the same localized name', async () => {
    expect(await service.request({ action: 'newChat' })).toMatchObject({
      ok: true,
      data: { connection: { sessionId: 'created-1' } }
    })
    expect(mocks.createSession).toHaveBeenCalledWith(
      DEFAULT_OPENCODE_AGENT_ID,
      expect.objectContaining({ name: '微信会话' })
    )
    expect(modelCalls).toBe(0)
  })

  it('reconnects an explicitly bound account without creating duplicate conversations or requiring new consent', async () => {
    await internal.connect(false)
    expect(internal.connection.status).toBe('connected')
    expect(mocks.login).toHaveBeenCalledWith({ force: false })
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.listen).toHaveBeenCalledTimes(1)
  })

  it('allows an explicitly disconnected account to be scanned and confirmed again without deleting history', async () => {
    expect(await service.request({ action: 'disconnect' })).toMatchObject({
      ok: true,
      data: { connection: { status: 'disconnected', enabled: false } }
    })
    await service.request({ action: 'login' })
    await vi.waitFor(() => expect(internal.connection.status).toBe('awaiting_confirmation'))
    expect(await service.request({ action: 'confirm', authorized: true })).toMatchObject({
      ok: true,
      data: { connection: { status: 'connected', enabled: true } }
    })
    expect((await client.execute({ sql: 'SELECT id FROM sessions WHERE id = ?', args: ['session'] })).rows).toEqual([
      { id: 'session' }
    ])
  })

  it('uses the main-process translation for WeChat control replies as well as conversation names', async () => {
    await internal.receive(input('stop-command', '停止'))
    expect(await service.repository.deliveries(channelId)).toEqual([
      expect.objectContaining({ role: 'notice', text: '已停止，已保存的文件和会话记录保留。' })
    ])
    expect(modelCalls).toBe(0)
  })

  it('retains the previous binding but does not start listening when login fails', async () => {
    mocks.login.mockRejectedValueOnce(new Error('wechat_secure_storage_unavailable'))
    await internal.connect(true)
    expect(internal.connection).toEqual({ status: 'failed', reason: 'automation_wechat_login_failed' })
    expect(await service.repository.getBinding(channelId)).toMatchObject({ sessionId: 'session' })
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.listen).not.toHaveBeenCalled()
  })

  it('validates sender identity and deduplicates the same incoming ID before any model call', async () => {
    await internal.receive({ ...input('wrong'), userId: 'stranger' })
    await internal.receive({ ...input('wrong-account'), accountId: 'other' })
    expect(modelCalls).toBe(0)
    await internal.receive(input('one'))
    await settled()
    await internal.receive(input('one'))
    await settled()
    expect(modelCalls).toBe(1)
    expect((await client.execute('SELECT state,result FROM assistant_automation_runs')).rows).toMatchObject([
      { state: 'completed', result: 'Final answer' }
    ])
    expect(await service.repository.deliveries(channelId)).toHaveLength(1)
    expect(mocks.persist).toHaveBeenCalled()
  })
  it('exposes delivery receipts only after acknowledgement and hides them when synchronization is disabled', async () => {
    await internal.receive(input('receipt'))
    await settled()
    expect(await service.request({ action: 'status' })).toMatchObject({ ok: true, data: { syncedRuns: [] } })
    const delivery = await service.repository.claimDelivery(channelId)
    expect(delivery).toBeDefined()
    expect(await service.request({ action: 'status' })).toMatchObject({ ok: true, data: { syncedRuns: [] } })
    await service.repository.settleDelivery(delivery!.id, delivery!.lease!, { status: 'accepted' })
    expect(await service.request({ action: 'status' })).toMatchObject({
      ok: true,
      data: { syncedRuns: [{ id: delivery!.runId, sessionId: 'session' }] }
    })
    expect(await service.request({ action: 'sync', sessionId: 'session', enabled: false })).toMatchObject({
      ok: true,
      data: { syncedRuns: [] }
    })
    expect(modelCalls).toBe(1)
  })

  it('queues when a desktop task owns the shared slot without incrementing failures', async () => {
    const release = acquireSessionActivity('desktop', 'run', 1)
    try {
      await internal.receive(input('queued'))
      await settled()
      expect(modelCalls).toBe(0)
      expect(await service.repository.queued()).toHaveLength(1)
    } finally {
      release()
    }
    await internal.tick()
    await settled()
    expect(modelCalls).toBe(1)
  })
  it('does not start a queued task until its attachment inventory is durably saved', async () => {
    let resolve!: (value: unknown) => void
    internal.bot = {
      stop: vi.fn(),
      downloadFile: () =>
        new Promise((done) => {
          resolve = done
        })
    }
    const receive = internal.receive({
      ...input('attachment', '总结这个文件'),
      type: 'file',
      _fileItems: [{ file_name: 'notes.txt' }]
    })
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    await internal.tick()
    expect(modelCalls).toBe(0)
    resolve({ data: Buffer.from('hello'), filename: 'notes.txt' })
    await receive
    await internal.tick()
    await settled()
    expect(modelCalls).toBe(1)
    expect((await client.execute('SELECT paths FROM assistant_automation_inputs')).rows).toHaveLength(1)
    expect(mocks.execute.mock.calls[0][1].content).toContain('<untrusted-attachments>')
    const options = mocks.execute.mock.calls[0][3]
    expect(options.displayContent).toBe('总结这个文件')
    expect(options.files).toHaveLength(1)
    const pending = mocks.persist.mock.calls[0][0].user.payload
    expect(pending.blocks).toContainEqual(
      expect.objectContaining({
        type: 'file',
        file: expect.objectContaining({ path: options.files[0].path, ext: '.txt' }),
        metadata: { automationAttachment: { owned_copy: true } }
      })
    )
    expect(pending.blocks[0].content).not.toContain('<untrusted-attachments>')
  })
  it('saves a linked, sanitized failure without throwing away the original cause', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('runtime-startup failed'))
    await internal.receive(input('failed'))
    await settled()
    const failure = mocks.persist.mock.calls.at(-1)![0].payload
    expect(failure.message.createdAt).toEqual(expect.any(String))
    const block = failure.blocks.at(-1)
    expect(block.type).toBe('error')
    expect(block.error.zenDiagnosticId).toMatch(/^automation-/)
    expect(JSON.stringify(block.error.cause)).toContain('runtime-startup failed')
    expect((await client.execute('SELECT state FROM assistant_automation_runs')).rows[0].state).toBe('failed')
  })
  it('executes an immutable schedule snapshot once and logs the model actually selected by current policy', async () => {
    const id = await service.schedules.save({
      name: 'brief',
      prompt: 'summarize',
      model: 'removed:model',
      scheduleType: 'interval',
      scheduleValue: '5',
      notify: false,
      authorized: true
    })
    const slot = await service.schedules.enqueue(id, true)
    await client.execute({
      sql: 'UPDATE assistant_automation_task_slots SET session_id=? WHERE id=?',
      args: ['session', slot!.id]
    })
    mocks.getSession.mockResolvedValue({
      id: 'session',
      agent_id: DEFAULT_OPENCODE_AGENT_ID,
      model: 'removed:model',
      configuration: {},
      accessible_paths: []
    })
    await settled()
    expect(modelCalls).toBe(1)
    expect((await client.execute('SELECT status,model_id FROM task_run_logs')).rows).toMatchObject([
      { status: 'success', model_id: 'zen:model' }
    ])
    await settled()
    expect(modelCalls).toBe(1)
  })
  it('releases the durable run even if saving the failure message also fails', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('runtime failure'))
    mocks.persist.mockRejectedValueOnce(new Error('history write failed'))
    await internal.receive(input('history-failed'))
    await settled()
    expect((await client.execute('SELECT state FROM assistant_automation_runs')).rows[0].state).toBe('failed')
    expect(await service.repository.queued()).toHaveLength(0)
  })
  it('keeps a successful answer successful and releases its lease when delivery queue creation fails', async () => {
    vi.spyOn(service.repository, 'completeRun').mockRejectedValueOnce(new Error('outbox write failed'))
    await internal.receive(input('queue-write-failed'))
    await settled()
    expect(modelCalls).toBe(1)
    expect((await client.execute('SELECT state,result FROM assistant_automation_runs')).rows[0]).toMatchObject({
      state: 'completed',
      result: 'Final answer'
    })
    await internal.receive(input('next-question'))
    await settled()
    expect(modelCalls).toBe(2)
  })
  it('requires notification consent again after a binding is paused', async () => {
    const binding = await service.repository.getBinding(channelId)
    await service.schedules.save(
      {
        name: 'brief',
        prompt: 'summarize',
        scheduleType: 'interval',
        scheduleValue: '5',
        notify: true,
        authorized: true
      },
      { channelId, version: binding!.version }
    )
    const before = await service.request({ action: 'status' })
    expect(before.ok && before.data.tasks[0].notificationNeedsConfirmation).toBe(false)
    await service.repository.disable(channelId, binding!.version)
    const after = await service.request({ action: 'status' })
    expect(after.ok && after.data.tasks[0].notificationNeedsConfirmation).toBe(true)
  })
  it('syncs only the bound desktop conversation and keeps its restricted profile after reload', async () => {
    expect(getAutomationProfile(await prepareAutomationSession(await mocks.getSession()))?.kind).toBe('wechat')
    await mirrorAutomationExchange('unrelated', 'private question', 'private answer')
    expect(await service.repository.deliveries(channelId)).toHaveLength(0)
    await mirrorAutomationExchange('session', 'desktop question', 'desktop answer')
    expect(await service.repository.deliveries(channelId)).toHaveLength(2)
    expect(modelCalls).toBe(0)
    await service.request({ action: 'sync', sessionId: 'session', enabled: false })
    await internal.receive(input('after-pause'))
    expect(modelCalls).toBe(0)
  })

  it('publishes main-owned stable identities for a phone turn and mirrors a desktop continuation only once', async () => {
    await internal.receive(input('phone-start'))
    await settled()
    expect(modelCalls).toBe(1)
    const published = vi.mocked(sessionStreamBus.publish).mock.calls.map(([, event]) => event)
    const user = published.find((event) => event.type === 'user-message')!
    expect(user.persistence?.userMessageId).toMatch(/:user$/)
    expect(published.find((event) => event.type === 'complete')?.persistence).toEqual(user.persistence)
    const context = { target: await captureAutomationMirrorTarget('session'), exchangeId: 'desktop-followup' }
    await mirrorAutomationExchange('session', '电脑追问', '电脑回答', false, [], context)
    await mirrorAutomationExchange('session', '电脑追问', '电脑回答', false, [], context)
    await settled()
    expect(modelCalls).toBe(1)
    const parts = await service.repository.deliveries(channelId)
    expect(parts.toReversed().map((part) => part.text)).toEqual(['Final answer', '电脑追问', '电脑回答'])
    expect((await client.execute("SELECT state FROM assistant_automation_runs WHERE origin='desktop'")).rows).toEqual([
      { state: 'completed' }
    ])
  })

  it('skips unrelated conversations and rejects paused or rebound desktop delivery targets', async () => {
    expect(await mirrorAutomationExchange('unrelated', 'q', 'a')).toBe(false)
    const context = { target: await captureAutomationMirrorTarget('session'), exchangeId: 'before-pause' }
    await service.repository.disable(channelId, context.target!.version)
    await expect(mirrorAutomationExchange('session', 'q', 'a', false, [], context)).rejects.toThrow('binding_changed')
    expect(await service.repository.deliveries(channelId)).toHaveLength(0)
    expect(await mirrorAutomationExchange('session', 'q', 'a', false, [], { exchangeId: 'not-bound' })).toBe(false)
    expect(modelCalls).toBe(0)
  })
  it('requires consent and rejects malformed configuration without side effects', async () => {
    expect(await service.request({ action: 'confirm' })).toMatchObject({
      ok: false,
      code: 'automation_invalid_request'
    })
    expect(
      await service.request({ action: 'createTask', task: { name: 'x', prompt: 'x', authorized: false } })
    ).toMatchObject({ ok: false })
    expect(modelCalls).toBe(0)
    expect((await client.execute('SELECT * FROM scheduled_tasks')).rows).toHaveLength(0)
  })
})
