import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { modelsService } from '@main/apiServer/services/models'
import { apiServerService } from '@main/services/ApiServerService'
import { configManager } from '@main/services/ConfigManager'
import { recordMainDiagnostic } from '@main/services/DiagnosticEvidenceService'
import { remoteModelPolicyService } from '@main/services/RemoteModelPolicyService'
import { getDataPath } from '@main/utils'
import { t } from '@main/utils/locales'
import {
  type AutomationOverview,
  type AutomationRequest,
  automationRequestSchema,
  type AutomationResponse
} from '@shared/agents/automation'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { sanitizeDiagnostic } from '@shared/diagnostics'
import type { AgentPersistedMessage, FileMetadata } from '@types'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import { resolveAssistantFallbackModel } from '../../../../../renderer/src/config/agentModelPolicy'
import { BaseService } from '../../BaseService'
import {
  agentsTable,
  automationInputs,
  automationSessions,
  automationTaskSlots,
  channelsTable,
  scheduledTasksTable,
  sessionMessagesTable,
  sessionsTable,
  taskRunLogsTable
} from '../../database/schema'
import { agentMessageRepository } from '../../database/sessionMessageRepository'
import { type IncomingMessage, WeixinBot } from '../channels/adapters/wechat/WeChatProtocol'
import { sessionStreamBus } from '../channels/SessionStreamBus'
import { broadcastSessionChanged } from '../channels/sessionStreamIpc'
import { assertAssistantDataAvailable } from '../dataOperationGate'
import {
  getManagedRecoveryInventory,
  rememberPreferredModel,
  resolveManagedSessionModel
} from '../managedModelRecovery'
import { ensureOpenCodeAgent } from '../opencode/builtin'
import { acquireSessionActivity, hasSessionActivity } from '../sessionActivity'
import { sessionMessageService } from '../SessionMessageService'
import { sessionService } from '../SessionService'
import { AutomationOutbox, type AutomationTextTransport } from './AutomationOutbox'
import { type AutomationFile, AutomationRepository } from './AutomationRepository'
import { AutomationScheduleRepository } from './AutomationScheduleRepository'
import { registerAutomationBridge } from './bridge'
import {
  AUTOMATION_BATCH_LIMIT,
  AUTOMATION_FILE_COUNT,
  automationOutputPaths,
  headlessAttachmentBlocks,
  safeAutomationReply,
  saveAutomationInput,
  verifiedAutomationFile
} from './files'
import { applyAutomationProfile } from './profile'

const logger = loggerService.withContext('AutomationService')
const CHANNEL = 'zen-opencode-wechat'
const QUEUE_TTL = 10 * 60_000
type Connection = AutomationOverview['connection']
type Active = { controller: AbortController; taskId?: string; promise: Promise<void> }

/** Entry orchestration only: one call to the existing native runtime, never a second agent loop. */
export class AutomationService extends BaseService {
  readonly repository = new AutomationRepository(() => this.getDatabase())
  readonly schedules = new AutomationScheduleRepository(() => this.getDatabase())
  private readonly outbox = new AutomationOutbox(this.repository, 60_000)
  private initialization?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private bot?: WeixinBot
  private authenticated?: { accountId: string; peerId: string }
  private connection: Connection = { status: 'disconnected' }
  private generation = 0
  private busy = false
  private stopping = false
  private pendingTick?: Promise<void>
  private deliveryBusy = false
  private deliveryController?: AbortController
  private deliveryPromise?: Promise<void>
  private receiveController = new AbortController()
  private readonly receives = new Set<Promise<void>>()
  private receiving = 0
  private readonly active = new Map<string, Active>()
  private lastTick = Date.now()
  private lastCompaction = 0
  private timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

  async start() {
    if (this.initialization) return this.initialization
    this.initialization = this.initialize().catch((error) => {
      this.initialization = undefined
      throw error
    })
    return this.initialization
  }

  private async initialize() {
    await this.repository.recoverInterrupted()
    await this.schedules.recover()
    registerAutomationBridge({
      prepare: async (session) => {
        const db = await this.getDatabase()
        const [profile] = await db.select().from(automationSessions).where(eq(automationSessions.sessionId, session.id))
        return profile ? applyAutomationProfile(session, profile) : session
      },
      invalidate: async (sessionId) => {
        const binding = await this.repository.bindingForSession(sessionId)
        if (binding) {
          this.deliveryController?.abort()
          await this.repository.disable(binding.channelId, binding.version)
        }
      },
      captureMirrorTarget: (sessionId) => this.repository.bindingForSession(sessionId),
      mirror: async (sessionId, input, answer, stopped, paths, context) => {
        const binding = context ? context.target : await this.repository.bindingForSession(sessionId)
        if (!binding || binding.sessionId !== sessionId) return false
        const db = await this.getDatabase()
        const [profile] = await db.select().from(automationSessions).where(eq(automationSessions.sessionId, sessionId))
        let fileFailure = false
        let total = 0
        const files: AutomationFile[] = []
        if (!stopped && profile)
          for (const [index, file] of paths.entries()) {
            try {
              const verified = await verifiedAutomationFile(file, profile.workspace)
              if (
                index >= AUTOMATION_FILE_COUNT ||
                total + verified.size > AUTOMATION_BATCH_LIMIT ||
                path.relative(profile.workspace, file).split(path.sep)[0] === 'inputs'
              ) {
                fileFailure = true
                continue
              }
              total += verified.size
              files.push(verified)
            } catch {
              fileFailure = true
            }
          }
        const { run, duplicate } = await this.repository.mirrorCompletedExchange(
          binding,
          context?.exchangeId ?? randomUUID(),
          safeAutomationReply(input),
          stopped ? t('automation.notice.stopped') : safeAutomationReply(answer) || t('automation.notice.empty'),
          files
        )
        if (duplicate) return { runId: run.id }
        if (fileFailure)
          await this.repository.enqueueNotice(
            binding,
            `${run.id}:file-limit`,
            t('automation.notice.fileDeliveryLimited')
          )
        this.kickDelivery()
        return { runId: run.id }
      }
    })
    this.timer = setInterval(() => {
      void this.tick().catch(() => logger.warn('Automation background tick failed', { code: 'automation_tick_failed' }))
    }, 5000)
    this.timer.unref()
    const db = await this.getDatabase()
    const [channel] = await db
      .select()
      .from(channelsTable)
      .where(
        and(
          eq(channelsTable.id, CHANNEL),
          eq(channelsTable.agentId, DEFAULT_OPENCODE_AGENT_ID),
          eq(channelsTable.isActive, true)
        )
      )
    if (channel) void this.connect(false)
  }

  async stop() {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.generation++
    this.deliveryController?.abort()
    this.receiveController.abort()
    this.bot?.stop()
    for (const run of this.active.values()) run.controller.abort('application shutdown')
    await this.pendingTick?.catch(() => {})
    await Promise.allSettled([...this.receives])
    await this.deliveryPromise
    await Promise.allSettled([...this.active.values()].map((entry) => entry.promise))
    this.bot = undefined
  }

  async request(raw: unknown): Promise<AutomationResponse> {
    const parsed = automationRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, code: 'automation_invalid_request' }
    try {
      await this.start()
      assertAssistantDataAvailable()
      if (parsed.data.action === 'status') return { ok: true, data: await this.overview() }
      const release = acquireSessionActivity('automation:configuration', 'continuation')
      try {
        await this.act(parsed.data)
      } finally {
        release()
      }
      return { ok: true, data: await this.overview() }
    } catch (error) {
      const code =
        error instanceof Error && /^automation_[a-z_]+$/.test(error.message)
          ? error.message
          : 'automation_operation_failed'
      logger.warn('Automation operation failed', {
        code,
        action: parsed.data.action,
        error: sanitizeDiagnostic(error)
      })
      return { ok: false, code }
    }
  }

  private async act(request: AutomationRequest) {
    if (request.action === 'login') {
      void this.connect(true)
      return
    }
    if (request.action === 'confirm') {
      await this.confirm()
      return
    }
    if (request.action === 'disconnect') {
      await this.disconnect()
      return
    }
    if (request.action === 'newChat') {
      await this.newChat()
      return
    }
    if (request.action === 'stopSession') {
      await this.abort(request.sessionId)
      return
    }
    if (request.action === 'sync') {
      const binding = await this.repository.getStoredBinding(CHANNEL)
      if (!binding) throw new Error('automation_not_bound')
      if (!request.enabled) {
        if (binding.sessionId !== request.sessionId) throw new Error('automation_binding_changed')
        this.deliveryController?.abort()
        await this.repository.disable(CHANNEL, binding.version)
        return
      }
      const db = await this.getDatabase()
      const [profile] = await db
        .select()
        .from(automationSessions)
        .where(and(eq(automationSessions.sessionId, request.sessionId), eq(automationSessions.kind, 'wechat')))
      if (
        !profile ||
        !this.authenticated ||
        hasSessionActivity(binding.sessionId) ||
        hasSessionActivity(request.sessionId)
      )
        throw new Error('automation_binding_busy')
      await this.repository.bind(
        { channelId: CHANNEL, ...this.authenticated, sessionId: request.sessionId },
        binding.version
      )
      return
    }
    if (request.action === 'delivery') {
      await this.repository.resolveDelivery(request.id, request.decision)
      this.kickDelivery()
      return
    }
    if (request.action === 'createTask' || request.action === 'updateTask') {
      await this.model(request.task.model)
      const binding = await this.repository.getBinding(CHANNEL)
      await this.schedules.save(request.task, binding, request.action === 'updateTask' ? request.id : undefined)
      return
    }
    if (request.action === 'task') {
      const entry = [...this.active.entries()].find(([, run]) => run.taskId === request.id)
      if (request.operation === 'stop') {
        await this.schedules.cancelQueued(request.id)
        if (entry) await this.abort(entry[0])
        return
      }
      if (request.operation === 'run') {
        await this.schedules.enqueue(request.id, true)
        this.kick()
        return
      }
      if (entry && request.operation === 'delete') await this.abort(entry[0])
      await this.schedules.setStatus(request.id, request.operation)
    }
  }

  private async model(preferred?: string | null) {
    if (!(await ensureOpenCodeAgent())) throw new Error('automation_no_model')
    await sessionService.reconcileManagedModels()
    const database = await this.getDatabase()
    const [agent] = await database.select().from(agentsTable).where(eq(agentsTable.id, DEFAULT_OPENCODE_AGENT_ID))
    const inventory = await getManagedRecoveryInventory()
    const selected = preferred || agent?.model
    {
      const resolution = resolveManagedSessionModel(
        preferred ? `automation-candidate:${selected}` : `agent:${DEFAULT_OPENCODE_AGENT_ID}`,
        selected || undefined,
        inventory,
        false
      )
      if (resolution.managed) {
        if (!resolution.selected) throw new Error('automation_no_model')
        return resolution.selected
      }
    }
    const { data } = await modelsService.getModels({})
    const value = resolveAssistantFallbackModel(
      data,
      preferred || undefined,
      remoteModelPolicyService.getSnapshot().policy,
      configManager.getEnableDeveloperMode()
    )
    if (!value) throw new Error('automation_no_model')
    return value.id
  }

  private async createSession(kind: 'wechat' | 'schedule', name: string, model?: string | null) {
    const workspace = path.join(getDataPath('Automation'), kind, randomUUID())
    await fs.mkdir(workspace, { recursive: true })
    const selectedModel = await this.model(model)
    const session = await sessionService.createSession(DEFAULT_OPENCODE_AGENT_ID, {
      name,
      model: selectedModel,
      accessible_paths: [workspace],
      instructions: '',
      mcps: [],
      allowed_tools: [],
      plan_model: selectedModel,
      small_model: selectedModel,
      configuration: { permission_mode: 'bypassPermissions', max_turns: 100, env_vars: {} }
    })
    if (!session) throw new Error('automation_session_failed')
    if (
      model &&
      resolveManagedSessionModel(`automation-candidate:${model}`, model, await getManagedRecoveryInventory(), false)
        .managed
    ) {
      rememberPreferredModel(session.id, model, selectedModel)
    }
    const db = await this.getDatabase()
    await db.insert(automationSessions).values({ sessionId: session.id, kind, workspace, createdAt: Date.now() })
    broadcastSessionChanged(DEFAULT_OPENCODE_AGENT_ID, session.id, true, 'created')
    return session
  }

  private async connect(force: boolean) {
    if (this.connection.status === 'logging_in' || this.connection.status === 'awaiting_confirmation') return
    const generation = ++this.generation
    this.deliveryController?.abort()
    this.receiveController.abort()
    this.receiveController = new AbortController()
    this.bot?.stop()
    this.authenticated = undefined
    this.connection = { status: 'logging_in' }
    const bot = new WeixinBot({
      strict: true,
      tokenPath: path.join(getDataPath('Automation'), 'wechat', 'credentials.json'),
      onQrUrl: (qr) => {
        if (generation === this.generation) this.connection = { status: 'logging_in', qr }
      },
      onError: (error) => {
        if (generation !== this.generation) return
        this.connection = {
          status: error instanceof Error && error.message === 'wechat_login_expired' ? 'expired' : 'reconnecting',
          reason: 'automation_wechat_connection_failed'
        }
      }
    })
    this.bot = bot
    try {
      const credentials = await bot.login({ force })
      if (generation !== this.generation) {
        bot.stop()
        return
      }
      this.authenticated = { accountId: credentials.accountId, peerId: credentials.userId }
      const binding = await this.repository.getStoredBinding(CHANNEL)
      if (
        !force &&
        binding?.enabled &&
        binding.accountId === credentials.accountId &&
        binding.peerId === credentials.userId
      ) {
        this.listen(bot, generation)
      } else this.connection = { status: 'awaiting_confirmation', owner: credentials.userId.slice(-6) }
    } catch (error) {
      if (generation === this.generation) {
        logger.warn('Automation WeChat login failed', { error: sanitizeDiagnostic(error) })
        this.connection = { status: 'failed', reason: 'automation_wechat_login_failed' }
      }
    }
  }

  private async confirm() {
    if (this.connection.status !== 'awaiting_confirmation' || !this.authenticated || !this.bot)
      throw new Error('automation_login_not_ready')
    const db = await this.getDatabase()
    const old = await this.repository.getStoredBinding(CHANNEL)
    if (old && hasSessionActivity(old.sessionId)) throw new Error('automation_binding_busy')
    const session = await this.createSession('wechat', t('automation.wechatConversation'))
    await db
      .insert(channelsTable)
      .values({
        id: CHANNEL,
        name: 'OpenCode WeChat',
        type: 'wechat',
        agentId: DEFAULT_OPENCODE_AGENT_ID,
        isActive: true,
        config: { type: 'wechat', token_path: '', allowed_chat_ids: [this.authenticated.peerId] }
      })
      .onConflictDoUpdate({
        target: channelsTable.id,
        set: {
          isActive: true,
          agentId: DEFAULT_OPENCODE_AGENT_ID,
          config: { type: 'wechat', token_path: '', allowed_chat_ids: [this.authenticated.peerId] }
        }
      })
    await this.repository.bind({ channelId: CHANNEL, ...this.authenticated, sessionId: session.id }, old?.version ?? 0)
    this.listen(this.bot, this.generation)
  }

  private listen(bot: WeixinBot, generation: number) {
    this.connection = { status: 'connected' }
    bot.onMessage(async (message) => {
      if (generation !== this.generation) return
      await this.receive(message)
    })
    void bot.run().catch(() => {
      if (generation === this.generation)
        this.connection = { status: 'failed', reason: 'automation_wechat_connection_failed' }
    })
  }

  private async disconnect() {
    this.generation++
    this.deliveryController?.abort()
    this.receiveController.abort()
    this.bot?.stop()
    this.bot = undefined
    this.authenticated = undefined
    const binding = await this.repository.getStoredBinding(CHANNEL)
    if (binding) {
      await this.repository.disable(CHANNEL, binding.version)
      await this.abort(binding.sessionId)
    }
    const db = await this.getDatabase()
    await db.update(channelsTable).set({ isActive: false }).where(eq(channelsTable.id, CHANNEL))
    this.connection = { status: 'disconnected' }
  }

  private async newChat() {
    const binding = await this.repository.getBinding(CHANNEL)
    if (!binding || !this.authenticated || hasSessionActivity(binding.sessionId))
      throw new Error('automation_binding_busy')
    const session = await this.createSession('wechat', t('automation.wechatConversation'))
    await this.repository.bind({ channelId: CHANNEL, ...this.authenticated, sessionId: session.id }, binding.version)
  }

  private async receive(message: IncomingMessage) {
    if (this.stopping || this.receiveController.signal.aborted) return
    this.receiving++
    const work = this.receiveTrusted(message, this.receiveController.signal)
    this.receives.add(work)
    try {
      await work
    } finally {
      this.receives.delete(work)
      this.receiving--
    }
  }

  private async receiveTrusted(message: IncomingMessage, signal: AbortSignal) {
    const binding = await this.repository.getBinding(CHANNEL)
    if (
      !binding?.enabled ||
      !message.messageId ||
      message.accountId !== binding.accountId ||
      message.userId !== binding.peerId ||
      !this.authenticated ||
      this.authenticated.accountId !== binding.accountId
    )
      return
    const db = await this.getDatabase()
    const release = acquireSessionActivity(`automation:receive:${CHANNEL}`, 'continuation')
    try {
      // Dedup before downloads and commands too. Control messages cannot execute a model.
      const { run, duplicate } = await this.repository.acceptMessage(
        binding,
        message.messageId,
        'wechat',
        message.text.trim() || t('automation.notice.attachment')
      )
      if (duplicate) return
      if (['停止', '/stop'].includes(message.text.trim())) {
        await this.repository.endRun(run.id, 'stopped')
        const aborted = await this.abort(binding.sessionId)
        if (!aborted) await this.repository.enqueueNotice(binding, run.id, t('automation.notice.stopped'))
      } else if (['新对话', '/new'].includes(message.text.trim())) {
        await this.repository.endRun(run.id, 'stopped')
        try {
          await this.newChat()
          const next = await this.repository.getBinding(CHANNEL)
          if (next)
            await this.repository.enqueueNotice(next, `${run.id}:new-chat`, t('automation.notice.newChatStarted'))
        } catch (error) {
          await this.repository.enqueueNotice(
            binding,
            `${run.id}:new-failed`,
            t(
              error instanceof Error && error.message === 'automation_binding_busy'
                ? 'automation.errors.automation_binding_busy'
                : 'automation.notice.failed'
            )
          )
        }
      } else if (message.type === 'video') {
        await this.repository.endRun(run.id, 'failed')
        await this.repository.enqueueNotice(binding, run.id, t('automation.notice.unsupported'))
      } else {
        const [profile] = await db
          .select()
          .from(automationSessions)
          .where(eq(automationSessions.sessionId, binding.sessionId))
        if (!profile) throw new Error('automation_profile_missing')
        const items = [...(message._fileItems || []), ...(message._imageItems || [])]
        if (items.length > AUTOMATION_FILE_COUNT) throw new Error('automation_attachments_failed')
        const paths: string[] = []
        let total = 0
        for (const file of message._fileItems || []) {
          signal.throwIfAborted()
          const downloaded = await this.bot?.downloadFile(file, signal)
          if (!downloaded) throw new Error('automation_attachments_failed')
          total += downloaded.data.length
          if (total > AUTOMATION_BATCH_LIMIT) throw new Error('automation_attachments_failed')
          paths.push(await saveAutomationInput(profile.workspace, downloaded.filename, downloaded.data))
        }
        for (const image of message._imageItems || []) {
          signal.throwIfAborted()
          const imageUrl = await this.bot?.downloadImage(image, signal)
          if (!imageUrl) throw new Error('automation_attachments_failed')
          const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(imageUrl)
          if (!match) throw new Error('automation_attachments_failed')
          const data = Buffer.from(match[2], 'base64')
          total += data.length
          if (total > AUTOMATION_BATCH_LIMIT) throw new Error('automation_attachments_failed')
          paths.push(await saveAutomationInput(profile.workspace, `image.${match[1]}`, data))
        }
        if (paths.length) {
          signal.throwIfAborted()
          await db.insert(automationInputs).values({ runId: run.id, paths })
          const { automationRuns } = await import('../../database/schema')
          await db
            .update(automationRuns)
            .set({
              input: `${run.input}\n\n<untrusted-attachments>\n${paths.map((file) => JSON.stringify(file)).join('\n')}\n</untrusted-attachments>`
            })
            .where(eq(automationRuns.id, run.id))
        }
      }
    } catch (error) {
      // Do not silently answer from only part of a failed attachment batch.
      const { automationRuns } = await import('../../database/schema')
      const key = createHash('sha256')
        .update(JSON.stringify(['wechat', CHANNEL, binding.accountId, binding.peerId, message.messageId]))
        .digest('hex')
      const [run] = await db.select().from(automationRuns).where(eq(automationRuns.sourceKey, key))
      if (run) {
        await this.repository.endRun(run.id, 'failed')
        await this.repository.enqueueNotice(
          binding,
          `${run.id}:receive-failure`,
          t('automation.notice.attachmentFailed')
        )
      } else throw error
    } finally {
      release()
    }
    this.kickDelivery()
    this.kick()
  }

  private kick() {
    void this.tick().catch(() => logger.warn('Automation background tick failed', { code: 'automation_tick_failed' }))
  }

  private tick(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (!this.pendingTick)
      this.pendingTick = this.scan().finally(() => {
        this.pendingTick = undefined
      })
    return this.pendingTick
  }

  private async scan() {
    if (this.busy) return
    this.busy = true
    let release: (() => void) | undefined
    try {
      release = acquireSessionActivity('automation:poll', 'continuation')
      const now = Date.now()
      if (now - this.lastCompaction > 24 * 60 * 60_000) {
        await this.repository.compactDeliveredHistory()
        this.lastCompaction = now
      }
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const rebase = zone !== this.timezone || now < this.lastTick - 120_000
      const skipped = Math.abs(now - this.lastTick) > 120_000 || zone !== this.timezone
      this.lastTick = now
      this.timezone = zone
      for (const row of await this.schedules.tasks())
        if (row.task.status === 'active') await this.schedules.enqueue(row.task.id, false, skipped)
      if (rebase) await this.schedules.rebaseRecurring()
      for (const run of await this.repository.queued()) {
        if (this.receiving) break
        if (this.active.has(run.sessionId) || hasSessionActivity(run.sessionId)) continue
        if (now - run.createdAt > QUEUE_TTL) {
          await this.repository.endRun(run.id, 'failed')
          const binding = await this.repository.getBinding(run.channelId)
          if (binding)
            await this.repository.enqueueNotice(binding, `${run.id}:expired`, t('automation.notice.queueExpired'))
          continue
        }
        this.launch(run.sessionId, undefined, (controller) =>
          this.runWechat(run.id, run.sessionId, run.input, controller)
        )
      }
      for (const slot of await this.schedules.pending()) {
        if (await this.schedules.expireQueued(slot.id)) continue
        if ([...this.active.values()].some((entry) => entry.taskId === slot.taskId)) continue
        this.launch(`schedule:${slot.id}`, slot.taskId, (controller) => this.runSchedule(slot, controller))
      }
    } finally {
      release?.()
      this.busy = false
      this.kickDelivery()
    }
  }

  private launch(key: string, taskId: string | undefined, execute: (controller: AbortController) => Promise<void>) {
    if (this.stopping) return
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort('automation execution deadline'), 15 * 60_000)
    deadline.unref()
    const promise = Promise.resolve()
      .then(() => execute(controller))
      .catch(() => logger.warn('Automation run failed', { code: 'automation_run_failed' }))
      .finally(() => {
        clearTimeout(deadline)
        this.active.delete(key)
        this.kickDelivery()
      })
    this.active.set(key, { controller, taskId, promise })
  }

  async abort(sessionId: string): Promise<boolean> {
    let entry = this.active.get(sessionId)
    if (!entry) {
      const db = await this.getDatabase()
      const [slot] = await db
        .select()
        .from(automationTaskSlots)
        .where(and(eq(automationTaskSlots.sessionId, sessionId), eq(automationTaskSlots.state, 'running')))
      if (slot) entry = this.active.get(`schedule:${slot.id}`)
    }
    if (!entry) return false
    entry.controller.abort('user stopped automation')
    await entry.promise
    return true
  }

  private async execute(
    sessionId: string,
    input: string,
    id: string,
    controller: AbortController,
    onAdmitted: (model: string) => Promise<void>
  ) {
    controller.signal.throwIfAborted()
    if (!apiServerService.isRunning()) await apiServerService.start({ ensureBuiltinAgents: false })
    const session = await sessionService.getSession(DEFAULT_OPENCODE_AGENT_ID, sessionId)
    if (!session) throw new Error('automation_session_missing')
    const resolution = resolveManagedSessionModel(session.id, session.model, await getManagedRecoveryInventory())
    if (resolution.managed) {
      if (!resolution.selected) throw new Error('automation_no_model')
      // SessionMessageService resolves/persists it under the shared run lease;
      // do not overwrite the original selection before recording its intent.
    } else {
      session.model = await this.model(session.model)
    }
    const db = await this.getDatabase()
    const [inventory] = await db.select().from(automationInputs).where(eq(automationInputs.runId, id))
    const [profile] = await db.select().from(automationSessions).where(eq(automationSessions.sessionId, sessionId))
    const runtimeImages: Array<{ data: string; media_type: string }> = []
    const files: FileMetadata[] = []
    for (const file of inventory?.paths || []) {
      if (!profile) throw new Error('automation_profile_missing')
      const verified = await verifiedAutomationFile(file, profile.workspace)
      const extension = path.extname(file).toLowerCase()
      files.push({
        id: path.basename(file, extension),
        name: path.basename(file),
        origin_name: path.basename(file),
        path: verified.path,
        ext: extension,
        type: ['.jpg', '.jpeg', '.png', '.webp'].includes(extension) ? 'image' : 'document',
        size: verified.size,
        created_at: new Date().toISOString(),
        count: 1
      })
      if (['.jpg', '.jpeg', '.png', '.webp'].includes(extension))
        runtimeImages.push({
          data: (await fs.readFile(verified.path)).toString('base64'),
          media_type: extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
        })
    }
    const attachmentSuffix = inventory?.paths.length
      ? `\n\n<untrusted-attachments>\n${inventory.paths.map((file) => JSON.stringify(file)).join('\n')}\n</untrusted-attachments>`
      : ''
    const displayContent =
      attachmentSuffix && input.endsWith(attachmentSuffix) ? input.slice(0, -attachmentSuffix.length) : input
    const { stream, completion } = await sessionMessageService.createSessionMessage(
      session,
      { content: input },
      controller,
      {
        persist: true,
        strictPersistence: true,
        persistenceId: id,
        displayContent,
        files,
        onAdmitted: async (actualModel) => {
          controller.signal.throwIfAborted()
          if (actualModel) session.model = actualModel
          await onAdmitted(session.model)
          const now = new Date().toISOString()
          const userId = `${id}:user`
          const assistantId = `${id}:assistant`
          const userBlock = `${id}:user:text`
          const assistantBlock = `${id}:assistant:pending`
          const attachments = headlessAttachmentBlocks(files, userId, now)
          const common = {
            assistantId: DEFAULT_OPENCODE_AGENT_ID,
            topicId: `agent-session:${sessionId}`,
            createdAt: now
          }
          await agentMessageRepository.persistExchange({
            sessionId,
            agentSessionId: '',
            user: {
              payload: {
                message: {
                  ...common,
                  id: userId,
                  role: 'user',
                  status: 'success',
                  blocks: [userBlock, ...attachments.map((block) => block.id)]
                },
                blocks: [
                  {
                    id: userBlock,
                    messageId: userId,
                    type: 'main_text',
                    status: 'success',
                    createdAt: now,
                    content: displayContent
                  },
                  ...attachments
                ]
              } as AgentPersistedMessage
            },
            assistant: {
              payload: {
                message: {
                  ...common,
                  id: assistantId,
                  role: 'assistant',
                  askId: userId,
                  status: 'processing',
                  blocks: [assistantBlock],
                  modelId: session.model
                },
                blocks: [
                  {
                    id: assistantBlock,
                    messageId: assistantId,
                    type: 'main_text',
                    status: 'processing',
                    createdAt: now,
                    content: ''
                  }
                ]
              } as AgentPersistedMessage
            }
          })
        },
        diagnosticId: `automation-${id}`,
        runtimeImages
      }
    )
    const reader = stream.getReader()
    const persistence = { userMessageId: `${id}:user`, assistantMessageId: `${id}:assistant` }
    sessionStreamBus.publish(sessionId, {
      sessionId,
      agentId: DEFAULT_OPENCODE_AGENT_ID,
      persistence,
      type: 'user-message',
      userMessage: {
        chatId: CHANNEL,
        userId: 'owner',
        userName: 'WeChat',
        text: displayContent
      }
    })
    const consume = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          sessionStreamBus.publish(sessionId, {
            sessionId,
            agentId: DEFAULT_OPENCODE_AGENT_ID,
            persistence,
            type: 'chunk',
            chunk: value
          })
        }
      } finally {
        reader.releaseLock()
      }
    })()
    const [consumed, completed] = await Promise.allSettled([consume, completion])
    if (completed.status === 'rejected') throw completed.reason
    if (consumed.status === 'rejected') throw consumed.reason
    const result = completed.value
    recordMainDiagnostic(`automation-${id}`, 'runtime', 'complete', { stage: 'history_saved', entry: profile?.kind })
    const payload = result.assistantMessage?.content as AgentPersistedMessage | undefined
    if (controller.signal.aborted) throw new Error('automation_stopped')
    if (!payload) throw new Error('automation_result_not_saved')
    const final =
      (payload.message.providerMetadata?.zenAutomation as any)?.finalText ||
      payload.blocks
        .filter((block) => block.type === 'main_text')
        .map((block: any) => block.content)
        .join('\n')
    const outputs: Awaited<ReturnType<typeof verifiedAutomationFile>>[] = []
    let fileFailure = false
    let totalSize = 0
    for (const file of automationOutputPaths(payload.blocks)) {
      if (!profile || path.relative(profile.workspace, file).split(path.sep)[0] === 'inputs') continue
      try {
        const verified = await verifiedAutomationFile(file, profile.workspace)
        if (outputs.length >= AUTOMATION_FILE_COUNT || totalSize + verified.size > AUTOMATION_BATCH_LIMIT) {
          fileFailure = true
          continue
        }
        totalSize += verified.size
        outputs.push(verified)
      } catch {
        fileFailure = true
      }
    }
    broadcastSessionChanged(DEFAULT_OPENCODE_AGENT_ID, sessionId, true)
    sessionStreamBus.publish(sessionId, {
      sessionId,
      agentId: DEFAULT_OPENCODE_AGENT_ID,
      type: 'complete',
      persistence
    })
    return {
      text:
        (safeAutomationReply(String(final)) || t('automation.notice.empty')) +
        (fileFailure ? `\n\n${t('automation.notice.fileDeliveryLimited')}` : ''),
      files: outputs
    }
  }

  private async saveFailure(sessionId: string, id: string, stopped: boolean, cause?: unknown) {
    const now = new Date().toISOString()
    const messageId = `${id}:assistant`
    const blockId = `${id}:failure`
    const db = await this.getDatabase()
    const [existing] = await db
      .select()
      .from(sessionMessagesTable)
      .where(
        and(
          eq(sessionMessagesTable.session_id, sessionId),
          sql`json_extract(${sessionMessagesTable.content}, '$.message.id') = ${messageId}`
        )
      )
    const partial = existing ? (JSON.parse(existing.content) as AgentPersistedMessage) : undefined
    await agentMessageRepository.persistAssistantMessage({
      sessionId,
      agentSessionId: '',
      payload: {
        message: {
          id: messageId,
          assistantId: DEFAULT_OPENCODE_AGENT_ID,
          topicId: `agent-session:${sessionId}`,
          role: 'assistant',
          ...partial?.message,
          askId: `${id}:user`,
          createdAt: partial?.message.createdAt ?? now,
          updatedAt: now,
          status: stopped ? 'paused' : 'error',
          blocks: [...(partial?.message.blocks || []).filter((block) => block !== blockId), blockId],
          providerMetadata: {
            ...partial?.message.providerMetadata,
            zenAutomation: { id, diagnosticId: `automation-${id}` }
          }
        },
        blocks: [
          ...(partial?.blocks || []).filter((block) => block.id !== blockId),
          stopped
            ? {
                id: blockId,
                messageId,
                type: 'main_text',
                createdAt: now,
                status: 'paused',
                content: t('automation.notice.stopped')
              }
            : {
                id: blockId,
                messageId,
                type: 'error',
                createdAt: now,
                status: 'error',
                error: {
                  message: t('automation.notice.failed'),
                  zenDiagnosticId: `automation-${id}`,
                  cause: sanitizeDiagnostic(cause)
                }
              }
        ]
      } as AgentPersistedMessage
    })
    broadcastSessionChanged(DEFAULT_OPENCODE_AGENT_ID, sessionId, true)
    sessionStreamBus.publish(sessionId, {
      sessionId,
      agentId: DEFAULT_OPENCODE_AGENT_ID,
      type: 'error',
      persistence: { userMessageId: `${id}:user`, assistantMessageId: `${id}:assistant` },
      error: { message: t(stopped ? 'automation.notice.stopped' : 'automation.notice.failed') }
    })
  }

  private isBusy(error: unknown) {
    const code = (error as { code?: string })?.code
    return code === 'agent_task_limit' || code === 'continuation_busy' || code === 'assistant_data_busy'
  }

  private async runWechat(id: string, sessionId: string, input: string, controller: AbortController) {
    let result: Awaited<ReturnType<AutomationService['execute']>>
    let progressTimer: ReturnType<typeof setTimeout> | undefined
    let progress: Promise<unknown> | undefined
    try {
      result = await this.execute(sessionId, input, id, controller, async () => {
        if (!(await this.repository.claimRun(id))) throw new Error('automation_run_changed')
        // One acknowledgement for a genuinely running slow task, never a repeated model request.
        progressTimer = setTimeout(() => {
          progress = (async () => {
            const binding = await this.repository.bindingForSession(sessionId)
            if (binding && !controller.signal.aborted)
              await this.repository.enqueueNotice(binding, `${id}:processing`, t('automation.notice.processing'))
            this.kickDelivery()
          })().catch(() => logger.warn('Could not queue automation progress acknowledgement'))
        }, 30_000)
        progressTimer.unref()
      })
    } catch (error) {
      if (this.isBusy(error) || (error instanceof Error && error.message === 'automation_run_changed')) return
      const stopped =
        controller.signal.aborted &&
        ['user stopped automation', 'application shutdown'].includes(String(controller.signal.reason))
      try {
        await this.saveFailure(sessionId, id, stopped, error)
      } catch {
        logger.warn('Could not save automation failure message', { code: 'automation_history_save_failed', id })
      } finally {
        await this.repository.endRun(id, stopped ? 'stopped' : 'failed')
      }
      const binding = await this.repository.bindingForSession(sessionId)
      if (binding)
        await this.repository.enqueueNotice(
          binding,
          `${id}:failure`,
          t(stopped ? 'automation.notice.stopped' : 'automation.notice.failed')
        )
      broadcastSessionChanged(DEFAULT_OPENCODE_AGENT_ID, sessionId, true)
      return
    } finally {
      if (progressTimer) clearTimeout(progressTimer)
      await progress
    }
    // A delivery/storage failure cannot reclassify a saved successful model answer as failed.
    try {
      await this.repository.completeRun(id, result.text, result.files)
    } catch {
      recordMainDiagnostic(`automation-${id}`, 'runtime', 'failed', {
        stage: 'delivery_queue',
        code: 'automation_result_delivery_failed'
      })
      logger.warn('Saved automation result could not be queued for delivery', {
        code: 'automation_result_delivery_failed',
        id
      })
      // A queue/storage error must not leave a permanent running lease or cause paid work to replay.
      await this.repository.preserveCompletedResult(id, result.text).catch(() =>
        logger.warn('Could not finalize locally saved automation result', {
          code: 'automation_result_finalize_failed',
          id
        })
      )
    }
  }

  private async runSchedule(slot: typeof automationTaskSlots.$inferSelect, controller: AbortController) {
    const snapshot = JSON.parse(slot.snapshot) as Awaited<ReturnType<AutomationScheduleRepository['tasks']>>[number]
    let log: { id: number } | undefined
    const start = Date.now()
    let sessionId = slot.sessionId
    try {
      if (!sessionId) {
        const session = await this.createSession('schedule', snapshot.task.name, snapshot.task.model_id)
        sessionId = session.id
        const db = await this.getDatabase()
        await db.update(automationTaskSlots).set({ sessionId }).where(eq(automationTaskSlots.id, slot.id))
      }
      const result = await this.execute(sessionId, snapshot.task.prompt, slot.id, controller, async (model) => {
        log = await this.schedules.claim(slot.id, sessionId!, model)
      })
      await this.schedules.finish(slot.id, log!.id, 'completed', result.text, Date.now() - start)
      if (snapshot.settings.notifyChannelId && snapshot.settings.notifyVersion) {
        const binding = await this.repository.getBinding(snapshot.settings.notifyChannelId)
        if (binding?.version === snapshot.settings.notifyVersion) {
          try {
            await this.repository.enqueueNotice(binding, slot.id, `${snapshot.task.name}\n${result.text}`, result.files)
          } catch {
            recordMainDiagnostic(`automation-${slot.id}`, 'runtime', 'failed', {
              stage: 'delivery_queue',
              code: 'automation_result_delivery_failed'
            })
          }
        }
      }
    } catch (error) {
      if (this.isBusy(error) || (error instanceof Error && error.message === 'automation_slot_changed')) return
      const stopped =
        controller.signal.aborted &&
        ['user stopped automation', 'application shutdown'].includes(String(controller.signal.reason))
      if (sessionId && log)
        await this.saveFailure(sessionId, slot.id, stopped, error).catch(() =>
          logger.warn('Could not save scheduled failure message', {
            code: 'automation_history_save_failed',
            id: slot.id
          })
        )
      if (log)
        await this.schedules.finish(
          slot.id,
          log.id,
          stopped ? 'stopped' : 'failed',
          stopped ? 'automation_stopped' : 'automation_execution_failed',
          Date.now() - start
        )
      else {
        const db = await this.getDatabase()
        await db
          .update(automationTaskSlots)
          .set({ state: stopped ? 'stopped' : 'failed' })
          .where(eq(automationTaskSlots.id, slot.id))
        await db.insert(taskRunLogsTable).values({
          task_id: slot.taskId,
          session_id: sessionId,
          run_at: new Date().toISOString(),
          duration_ms: Date.now() - start,
          status: stopped ? 'paused' : 'error',
          error: stopped ? 'automation_stopped' : 'automation_preparation_failed'
        })
      }
    }
  }

  private kickDelivery() {
    if (this.deliveryBusy || !this.bot || !this.authenticated) return
    this.deliveryBusy = true
    const bot = this.bot
    const account = this.authenticated.accountId
    const generation = this.generation
    const controller = new AbortController()
    this.deliveryController = controller
    const send = async (request: Parameters<AutomationTextTransport['sendText']>[0], signal: AbortSignal) => {
      if (generation !== this.generation) return { status: 'failed' as const, reason: 'account_changed' }
      const diagnosticId = `automation-${request.runId}`
      try {
        recordMainDiagnostic(diagnosticId, 'runtime', 'start', { stage: 'wechat_submit', kind: 'text' })
        await bot.sendStable(
          request.target.peerId,
          request.role === 'user' ? `${t('automation.desktopMessage')}\n${request.text}` : request.text,
          request.deliveryKey,
          signal
        )
        recordMainDiagnostic(diagnosticId, 'runtime', 'complete', {
          stage: 'wechat_submit',
          kind: 'text',
          accepted: true
        })
        return { status: 'accepted' as const }
      } catch (error) {
        recordMainDiagnostic(diagnosticId, 'runtime', 'failed', { stage: 'wechat_submit', kind: 'text', error })
        return {
          status: (error as any)?.definitelyNotSent ? ('failed' as const) : ('unknown' as const),
          reason: 'wechat_send_failed'
        }
      }
    }
    const transport: AutomationTextTransport = {
      accountId: account,
      sendText: send,
      sendFile: async (request, signal) => {
        if (generation !== this.generation) return { status: 'failed', reason: 'account_changed' }
        const diagnosticId = `automation-${request.runId}`
        let stage = 'file_validation'
        try {
          const db = await this.getDatabase()
          // The immutable manifest constrains files independently of editable session paths.
          const profiles = await db.select().from(automationSessions)
          const profile = profiles.find((entry) => {
            const relative = path.relative(entry.workspace, request.path)
            return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
          })
          if (!profile) return { status: 'failed', reason: 'file_not_authorized' }
          const file = await verifiedAutomationFile(request.path, profile.workspace)
          if (file.sha256 !== request.sha256 || file.size !== request.size)
            return { status: 'failed', reason: 'file_changed' }
          const data = await fs.readFile(file.path)
          if (createHash('sha256').update(data).digest('hex') !== file.sha256)
            return { status: 'failed', reason: 'file_changed' }
          await bot.sendDocument(
            request.target.peerId,
            data,
            path.basename(file.path),
            request.deliveryKey,
            signal,
            (part) => {
              if (part === 'submit')
                recordMainDiagnostic(diagnosticId, 'runtime', 'complete', { stage: 'wechat_upload' })
              stage = part === 'upload' ? 'wechat_upload' : 'wechat_submit'
              recordMainDiagnostic(diagnosticId, 'runtime', 'start', { stage, kind: 'file', size: data.length })
            }
          )
          recordMainDiagnostic(diagnosticId, 'runtime', 'complete', { stage, kind: 'file', accepted: true })
          return { status: 'accepted' }
        } catch (error) {
          recordMainDiagnostic(diagnosticId, 'runtime', 'failed', { stage, kind: 'file', error })
          return { status: (error as any)?.definitelyNotSent ? 'failed' : 'unknown', reason: 'wechat_file_send_failed' }
        }
      }
    }
    this.deliveryPromise = (async () => {
      const release = acquireSessionActivity('automation:delivery', 'continuation')
      try {
        for (let i = 0; i < 32 && generation === this.generation; i++)
          if (!(await this.outbox.dispatchNext(CHANNEL, transport, controller.signal))) break
      } finally {
        release()
      }
    })()
      .catch(() => logger.warn('Automation delivery stopped', { code: 'automation_delivery_failed' }))
      .finally(() => {
        this.deliveryBusy = false
        if (this.deliveryController === controller) this.deliveryController = undefined
      })
  }

  private async overview(): Promise<AutomationOverview> {
    const db = await this.getDatabase()
    const binding = await this.repository.getStoredBinding(CHANNEL)
    const rows = await this.schedules.tasks()
    const oldTasks = await db
      .select()
      .from(scheduledTasksTable)
      .where(sql`${scheduledTasksTable.agent_id} <> ${DEFAULT_OPENCODE_AGENT_ID}`)
      .limit(100)
    const ids = rows.map(({ task }) => task.id)
    const logs = ids.length
      ? await db
          .select()
          .from(taskRunLogsTable)
          .where(inArray(taskRunLogsTable.task_id, ids))
          .orderBy(desc(taskRunLogsTable.id))
          .limit(100)
      : []
    const sessions = await db
      .select({ id: sessionsTable.id, name: sessionsTable.name })
      .from(sessionsTable)
      .innerJoin(automationSessions, eq(automationSessions.sessionId, sessionsTable.id))
      .where(eq(automationSessions.kind, 'wechat'))
      .orderBy(desc(automationSessions.createdAt))
      .limit(100)
    return {
      connection: { ...this.connection, sessionId: binding?.sessionId, enabled: binding?.enabled },
      syncedRuns: binding?.enabled ? await this.repository.syncedRuns(binding) : [],
      deliveries: (await this.repository.deliveries(CHANNEL)).map(({ id, state, role, reason, createdAt }) => ({
        id,
        state,
        role,
        reason,
        createdAt
      })),
      tasks: rows.map(({ task, settings }) => ({
        id: task.id,
        name: task.name,
        prompt: task.prompt,
        model: task.model_id,
        scheduleType: task.schedule_type,
        scheduleValue: task.schedule_value,
        status: task.status,
        nextRun: task.next_run,
        lastResult: task.last_result,
        notify: Boolean(settings.notifyChannelId),
        notificationNeedsConfirmation:
          Boolean(settings.notifyChannelId) &&
          (!binding?.enabled ||
            binding.channelId !== settings.notifyChannelId ||
            binding.version !== settings.notifyVersion)
      })),
      legacyTasks: oldTasks.map((task) => ({
        id: task.id,
        name: task.name,
        prompt: task.prompt,
        model: task.model_id,
        scheduleType: task.schedule_type,
        scheduleValue: task.schedule_value
      })),
      runs: logs.map((log) => ({
        id: log.id,
        taskId: log.task_id,
        sessionId: log.session_id,
        status: log.status,
        result: log.result,
        error: log.error,
        runAt: log.run_at
      })),
      sessions: sessions.map((session) => ({
        ...session,
        current: binding?.enabled === true && binding.sessionId === session.id
      }))
    }
  }
}

export const automationService = new AutomationService()
