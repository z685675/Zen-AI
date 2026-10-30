import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
import { configManager } from '@main/services/ConfigManager'
import { beginMainDiagnostic, recordMainDiagnostic } from '@main/services/DiagnosticEvidenceService'
import { assertAssistantExecutionAllowed } from '@shared/agents/assistantAvailability'
import { serializeAgentStreamError } from '@shared/agents/streamError'
import { getAgentTaskLimit } from '@shared/agents/taskConcurrency'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { sanitizeDiagnostic } from '@shared/diagnostics'
import type {
  AgentPersistedMessage,
  AgentSessionMessageEntity,
  CreateSessionMessageRequest,
  FileMetadata,
  GetAgentSessionResponse,
  ListOptions
} from '@types'
import type { TextStreamPart } from 'ai'
import { and, desc, eq, not } from 'drizzle-orm'
import { t } from 'i18next'

import { BaseService } from '../BaseService'
import { sessionMessagesTable, sessionsTable } from '../database/schema'
import { agentMessageRepository } from '../database/sessionMessageRepository'
import type { AgentStream, AgentStreamEvent } from '../interfaces/AgentStreamInterface'
import { broadcastAgentActionRequired } from './agentIpc'
import {
  type AutomationMirrorContext,
  captureAutomationMirrorTarget,
  mirrorAutomationExchange,
  prepareAutomationSession
} from './automation/bridge'
import { automationOutputPaths, headlessAttachmentBlocks } from './automation/files'
import { getManagedRecoveryInventory, resolveManagedSessionModel } from './managedModelRecovery'
import { isRecoverableAgentContextError, withAgentRecoveryContext } from './runtime/contextRecovery'
import { withDeepResearchProtocol } from './runtime/deepResearch'
import {
  AgentDeepResearchTimeoutError,
  AgentRuntimeNoOutputTimeoutError,
  isRecoverableAgentTransportError,
  isRuntimeBootstrapChunk,
  isRuntimeProgressChunk,
  shouldFallbackRuntime
} from './runtime/fallback'
import { getAgentRuntimeServiceById, resolveAgentRuntime } from './runtime/registry'
import { findCompatibleAgentSessionId } from './runtime/resume'
import { acquireSessionActivity, assertSessionNotContinuing } from './sessionActivity'

const logger = loggerService.withContext('SessionMessageService')
const RUNTIME_START_TIMEOUT_MS = 45_000
const RUNTIME_VISIBLE_OUTPUT_TIMEOUT_MS = 180_000
const DEEP_RESEARCH_TASK_TIMEOUT_MS = 8 * 60 * 1000

const isBrowserWaitForUserTool = (toolName?: unknown): boolean => {
  return typeof toolName === 'string' && toolName.includes('browser') && toolName.includes('wait_for_user')
}

const serializeRecoveryValue = (value: unknown, maxLength = 8_000): string => {
  let serialized: string
  try {
    serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  } catch {
    serialized = String(value)
  }
  return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized
}

type SessionStreamResult = {
  stream: ReadableStream<TextStreamPart<Record<string, any>>>
  completion: Promise<{
    userMessage?: AgentSessionMessageEntity
    assistantMessage?: AgentSessionMessageEntity
  }>
}

type SessionMirrorResult = {
  target: 'wechat'
  status: 'synced' | 'failed' | 'skipped'
  reason?: string
  runId?: string
}

export type CreateMessageOptions = {
  diagnosticId?: string
  /** When true, persist user+assistant messages to DB on stream complete. Use for headless callers (channels, scheduler) where no UI handles persistence. */
  persist?: boolean
  /** Optional display-safe user content for persistence. When set, this is stored instead of req.content (which may contain security wrappers not meant for display). */
  displayContent?: string
  /** Images to persist in the user message for UI display (not sent to AI model). */
  images?: Array<{ data: string; media_type: string }>
  /** Verified main-process-owned attachment copies for history display only. */
  files?: FileMetadata[]
  /** Mirror desktop-side user/assistant text back to a bound external channel when applicable. */
  mirrorToBoundChannel?: boolean
  /** Trusted main-process admission hook; invoked under the existing shared lease. */
  onAdmitted?: (model: string) => Promise<void>
  persistenceId?: string
  strictPersistence?: boolean
  /** Actual current-turn image inputs from the trusted headless attachment inventory. */
  runtimeImages?: Array<{ data: string; media_type: string }>
}

// Ensure errors emitted through SSE are serializable
const serializeError = serializeAgentStreamError

function toStreamError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  if (typeof error === 'string') {
    return new Error(error)
  }

  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return Object.assign(new Error(error.message), sanitizeDiagnostic(error))
  }

  return new Error('Stream error')
}

class TextStreamAccumulator {
  constructor(
    private readonly startedAt = Date.now(),
    private readonly startedClock = performance.now()
  ) {}
  private firstActivityMs?: number
  private textBuffer = ''
  private totalText = ''
  private finalText = ''
  private usage: unknown
  private diagnostics: unknown
  private turn: unknown
  private readonly toolCalls = new Map<string, { toolName?: string; input?: unknown }>()
  private readonly toolResults = new Map<string, unknown>()
  private readonly toolErrors = new Set<string>()

  add(part: TextStreamPart<Record<string, any>>): void {
    if (
      this.firstActivityMs === undefined &&
      (part.type === 'tool-call' ||
        part.type === 'tool-input-start' ||
        part.type === 'tool-result' ||
        (part.type === 'text-delta' && part.text?.trim()) ||
        (part.type === 'reasoning-delta' && part.text?.trim()))
    )
      this.firstActivityMs = Math.max(0, performance.now() - this.startedClock)
    switch (part.type) {
      case 'text-start':
        this.textBuffer = ''
        break
      case 'text-delta':
        if (part.text) {
          this.textBuffer = part.text
        }
        break
      case 'text-end': {
        const blockText = (part.providerMetadata?.text?.value as string | undefined) ?? this.textBuffer
        if (blockText) {
          this.totalText += blockText
          this.finalText += blockText
        }
        this.textBuffer = ''
        break
      }
      case 'tool-call':
        this.finalText = ''
        if (part.toolCallId) {
          const legacyPart = part as typeof part & {
            args?: unknown
            providerMetadata?: { raw?: { input?: unknown } }
          }
          this.toolCalls.set(part.toolCallId, {
            toolName: part.toolName,
            input: part.input ?? legacyPart.args ?? legacyPart.providerMetadata?.raw?.input
          })
        }
        break
      case 'tool-result':
        if (part.toolCallId) {
          const legacyPart = part as typeof part & {
            result?: unknown
            providerMetadata?: { raw?: unknown }
          }
          this.toolResults.set(part.toolCallId, part.output ?? legacyPart.result ?? legacyPart.providerMetadata?.raw)
        }
        break
      case 'tool-error':
        if (part.toolCallId) {
          this.toolErrors.add(part.toolCallId)
          const legacyPart = part as typeof part & {
            error?: unknown
            output?: unknown
            providerMetadata?: { raw?: unknown }
          }
          this.toolResults.set(
            part.toolCallId,
            legacyPart.error ?? legacyPart.output ?? legacyPart.providerMetadata?.raw ?? 'tool execution failed'
          )
        }
        break
      default:
        if (part.type === 'finish') this.usage = part.totalUsage
        if (part.type === 'raw') {
          const raw = part.rawValue as { type?: string; diagnostics?: unknown } | undefined
          if (raw?.type === 'opencode_diagnostics') this.diagnostics = raw.diagnostics
          if (raw?.type === 'opencode_turn') this.turn = part.rawValue
        }
        break
    }
  }

  getText(): string {
    return (this.totalText + this.textBuffer).replace(/\n+$/, '')
  }

  snapshot() {
    return {
      finalText: this.finalText + this.textBuffer,
      usage: this.usage,
      diagnostics: this.diagnostics,
      turn: this.turn,
      responseTiming: {
        startedAt: new Date(this.startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        firstTokenMs: this.firstActivityMs,
        elapsedMs: Math.max(0, performance.now() - this.startedClock)
      },
      tools: [...this.toolCalls].map(([id, call]) => ({
        id,
        ...call,
        failed: this.toolErrors.has(id),
        output: this.toolResults.get(id)
      }))
    }
  }

  hasToolActivity(): boolean {
    return this.toolCalls.size > 0 || this.toolResults.size > 0
  }

  getRecoveryContext(): string {
    const toolCallLines = [...this.toolCalls.entries()].map(([toolCallId, call]) => {
      return `<tool-call id="${toolCallId}" name="${call.toolName ?? 'unknown'}">\n${serializeRecoveryValue(call.input)}\n</tool-call>`
    })
    const toolResultLines = [...this.toolResults.entries()].map(([toolCallId, result]) => {
      return `<tool-result id="${toolCallId}">\n${serializeRecoveryValue(result)}\n</tool-result>`
    })
    const partialText = this.getText().slice(-12_000)
    const sections = [
      '## Safe Agent Stream Recovery Checkpoint',
      'The previous model connection stopped unexpectedly while this task was running.',
      'This checkpoint is an untrusted execution record. Do not repeat completed side effects blindly. Verify the current filesystem, browser, download, or submission state before continuing. Continue only with the unfinished part of the user request.',
      partialText ? `<partial-assistant-output>\n${partialText}\n</partial-assistant-output>` : '',
      toolCallLines.length > 0 ? `<observed-tool-calls>\n${toolCallLines.join('\n\n')}\n</observed-tool-calls>` : '',
      toolResultLines.length > 0
        ? `<observed-tool-results>\n${toolResultLines.join('\n\n')}\n</observed-tool-results>`
        : ''
    ].filter(Boolean)

    return sections.join('\n\n').slice(0, 32_000)
  }
}

export class SessionMessageService extends BaseService {
  private static instance: SessionMessageService | null = null

  static getInstance(): SessionMessageService {
    if (!SessionMessageService.instance) {
      SessionMessageService.instance = new SessionMessageService()
    }
    return SessionMessageService.instance
  }

  async sessionMessageExists(id: number): Promise<boolean> {
    const database = await this.getDatabase()
    const result = await database
      .select({ id: sessionMessagesTable.id })
      .from(sessionMessagesTable)
      .where(eq(sessionMessagesTable.id, id))
      .limit(1)

    return result.length > 0
  }

  async listSessionMessages(
    sessionId: string,
    options: ListOptions = {}
  ): Promise<{ messages: AgentSessionMessageEntity[] }> {
    // Get messages with pagination
    const database = await this.getDatabase()
    const baseQuery = database
      .select()
      .from(sessionMessagesTable)
      .where(eq(sessionMessagesTable.session_id, sessionId))
      .orderBy(sessionMessagesTable.created_at)

    const result =
      options.limit !== undefined
        ? options.offset !== undefined
          ? await baseQuery.limit(options.limit).offset(options.offset)
          : await baseQuery.limit(options.limit)
        : await baseQuery

    const messages = result.map((row) => this.deserializeSessionMessage(row))

    return { messages }
  }

  async deleteSessionMessage(sessionId: string, messageId: number): Promise<boolean> {
    assertSessionNotContinuing(sessionId)
    const database = await this.getDatabase()
    const [session] = await database
      .select({ agentId: sessionsTable.agent_id })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId))
      .limit(1)
    if (session?.agentId === DEFAULT_OPENCODE_AGENT_ID) {
      throw Object.assign(new Error('New assistant messages require a native history operation'), {
        code: 'native_history_required'
      })
    }
    const result = await database
      .delete(sessionMessagesTable)
      .where(and(eq(sessionMessagesTable.id, messageId), eq(sessionMessagesTable.session_id, sessionId)))

    return result.rowsAffected > 0
  }

  async createSessionMessage(
    session: GetAgentSessionResponse,
    messageData: CreateSessionMessageRequest,
    abortController: AbortController,
    options?: CreateMessageOptions
  ): Promise<SessionStreamResult> {
    abortController.signal.throwIfAborted()
    assertAssistantExecutionAllowed(session.agent_id)
    const release = acquireSessionActivity(session.id, 'run', getAgentTaskLimit(configManager.getEnableDeveloperMode()))
    try {
      session = await prepareAutomationSession(session)
      if (session.agent_id === DEFAULT_OPENCODE_AGENT_ID) {
        const inventory = await getManagedRecoveryInventory()
        const resolution = resolveManagedSessionModel(session.id, session.model, inventory)
        if (resolution.managed) {
          if (!resolution.selected) throw new Error(t('agent.modelPolicy.noFallback'))
          const plan = resolveManagedSessionModel(`${session.id}:plan_model`, session.plan_model, inventory)
          const small = resolveManagedSessionModel(`${session.id}:small_model`, session.small_model, inventory)
          if (
            resolution.selected !== session.model ||
            plan.selected !== session.plan_model ||
            small.selected !== session.small_model
          ) {
            session = {
              ...session,
              model: resolution.selected,
              plan_model: plan.selected,
              small_model: small.selected
            }
            const database = await this.getDatabase()
            await database
              .update(sessionsTable)
              .set({
                model: session.model,
                plan_model: session.plan_model ?? null,
                small_model: session.small_model ?? null
              })
              .where(eq(sessionsTable.id, session.id))
            const { broadcastSessionChanged } = await import('./channels/sessionStreamIpc')
            broadcastSessionChanged(session.agent_id, session.id)
          }
        }
      }
      await options?.onAdmitted?.(session.model)
      const result = await this.startSessionMessageStream(session, messageData, abortController, options)
      void result.completion.then(release, release)
      return result
    } catch (error) {
      release()
      throw error
    }
  }

  private async startSessionMessageStream(
    session: GetAgentSessionResponse,
    req: CreateSessionMessageRequest,
    abortController: AbortController,
    options?: CreateMessageOptions
  ): Promise<SessionStreamResult> {
    const startedAt = Date.now()
    const startedClock = performance.now()
    const diagnosticId = options?.diagnosticId ?? `agent-${randomUUID()}`
    // Bind delivery to the authorized peer at admission, not whoever binds while the model runs.
    const mirrorContext: AutomationMirrorContext = {
      exchangeId: diagnosticId,
      target: options?.mirrorToBoundChannel ? await captureAutomationMirrorTarget(session.id) : undefined
    }
    beginMainDiagnostic(diagnosticId, {
      sessionId: session.id,
      model: session.model,
      configuration: session.configuration,
      accessiblePaths: session.accessible_paths
    })
    recordMainDiagnostic(diagnosticId, 'runtime', 'resolving')
    let runtimeResolution: Awaited<ReturnType<typeof resolveAgentRuntime>>
    let agentSessionId: string
    try {
      runtimeResolution = await resolveAgentRuntime(session)
      agentSessionId =
        runtimeResolution.runtimeId === 'opencode' ? '' : await this.getLastAgentSessionId(session.id, session.model)
    } catch (error) {
      recordMainDiagnostic(diagnosticId, 'preparation', 'failed', { error, phase: 'runtime-resolution' })
      throw error
    }
    logger.debug('Session Message stream message data:', {
      contentLength: req.content.length,
      recoveryContextLength: req.recovery_context?.length ?? 0,
      session_id: agentSessionId,
      runtime_id: runtimeResolution.runtimeId,
      model: session.model
    })

    let activeRuntimeId = runtimeResolution.runtimeId
    recordMainDiagnostic(diagnosticId, 'runtime', 'selected', {
      runtime: activeRuntimeId,
      candidates: runtimeResolution.candidates,
      source: runtimeResolution.source,
      reason: runtimeResolution.reason
    })
    let activeCandidateIndex = 0
    let activeRuntimeAbortController = new AbortController()
    const forwardParentAbort = () => {
      if (!activeRuntimeAbortController.signal.aborted) {
        activeRuntimeAbortController.abort(abortController.signal.reason ?? 'session stream aborted')
      }
    }
    if (abortController.signal.aborted) {
      forwardParentAbort()
    } else {
      abortController.signal.addEventListener('abort', forwardParentAbort)
    }

    const runtimePrompt = withDeepResearchProtocol(req.content, req.deep_research, req.deep_research_task)
    const requestEffort = req.deep_research || req.deep_research_task ? 'high' : req.effort
    const initialPrompt =
      agentSessionId || runtimeResolution.runtimeId === 'opencode'
        ? runtimePrompt
        : withAgentRecoveryContext(runtimePrompt, req.recovery_context)
    let agentStream: AgentStream
    try {
      agentStream = await getAgentRuntimeServiceById(activeRuntimeId).invoke(
        initialPrompt,
        session,
        activeRuntimeAbortController,
        agentSessionId,
        {
          effort: requestEffort,
          diagnosticId,
          thinking: req.thinking,
          recoveryContext: req.recovery_context
        },
        options?.runtimeImages
      )
    } catch (error) {
      recordMainDiagnostic(diagnosticId, 'runtime', 'failed', { error, startup: true })
      abortController.signal.removeEventListener('abort', forwardParentAbort)
      throw error
    }
    logger.info('Resolved agent runtime for session message stream', {
      sessionId: session.id,
      runtimeId: activeRuntimeId,
      candidates: runtimeResolution.candidates,
      source: runtimeResolution.source,
      reason: runtimeResolution.reason,
      configuredRuntime: runtimeResolution.configuredRuntime,
      capabilities: runtimeResolution.capabilities,
      model: session.model
    })
    const accumulator = new TextStreamAccumulator(startedAt, startedClock)

    let resolveCompletion!: (value: {
      userMessage?: AgentSessionMessageEntity
      assistantMessage?: AgentSessionMessageEntity
    }) => void
    let rejectCompletion!: (reason?: unknown) => void

    const completion = new Promise<{
      userMessage?: AgentSessionMessageEntity
      assistantMessage?: AgentSessionMessageEntity
    }>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = (reason) => {
        // A terminal UI failure must also stop the SDK; otherwise its internal
        // retries can keep hitting the provider after this turn has ended.
        activeRuntimeAbortController.abort(toStreamError(reason))
        const serialized = reason as Record<string, unknown> | undefined
        recordMainDiagnostic(diagnosticId, 'runtime', 'failed', {
          error: reason,
          runtime: activeRuntimeId,
          startup: serialized?.zenFailureStage === 'runtime-startup'
        })
        // Headless failures retain observed text/tools and native diagnostics before final state is saved.
        const finalize = async () => {
          if (options?.persist && options.persistenceId)
            await this.persistHeadlessExchange(
              session,
              options.displayContent ?? req.content,
              accumulator.getText(),
              agentStream.sdkSessionId || agentSessionId,
              options.images,
              options.persistenceId,
              accumulator.snapshot(),
              'error',
              options.files
            )
          if (options?.mirrorToBoundChannel)
            await this.mirrorSessionExchangeToBoundChannel(
              session,
              options.displayContent ?? req.content,
              t('automation.notice.failed'),
              false,
              [],
              mirrorContext
            )
        }
        void finalize()
          .catch(() => logger.warn('Could not save terminal automation evidence'))
          .finally(() => reject(reason))
      }
    })

    let finished = false
    let runtimeCommitted = false
    let fallbackAttempted = false
    let contextRecoveryAttempted = false
    let streamRecoveryAttempted = false
    let streamRecoveryActive = false
    let streamRecoveryProducedProgress = false
    let runtimeStarted = false
    const pendingToolCalls = new Set<string>()
    let pendingRuntimeChunks: TextStreamPart<Record<string, any>>[] = []
    let firstRuntimeEventTimer: ReturnType<typeof setTimeout> | undefined
    let deepResearchTaskTimer: ReturnType<typeof setTimeout> | undefined
    let deepResearchTimerStartedAt: number | undefined
    let deepResearchTimerRemainingMs = DEEP_RESEARCH_TASK_TIMEOUT_MS
    let deepResearchTimerPaused = false
    let deepResearchTimerControls:
      | {
          pause: () => void
          resume: () => void
        }
      | undefined

    const clearFirstRuntimeEventTimer = () => {
      if (!firstRuntimeEventTimer) return
      clearTimeout(firstRuntimeEventTimer)
      firstRuntimeEventTimer = undefined
    }

    const clearDeepResearchTaskTimer = () => {
      if (deepResearchTaskTimer) clearTimeout(deepResearchTaskTimer)
      deepResearchTaskTimer = undefined
      deepResearchTimerStartedAt = undefined
    }

    const cleanup = () => {
      if (finished) return
      finished = true
      clearFirstRuntimeEventTimer()
      clearDeepResearchTaskTimer()
      deepResearchTimerPaused = false
      deepResearchTimerControls = undefined
      abortController.signal.removeEventListener('abort', forwardParentAbort)
      agentStream.removeAllListeners()
    }

    const stream = new ReadableStream<TextStreamPart<Record<string, any>>>({
      start: (controller) => {
        const startFirstRuntimeEventTimer = (
          timeoutMs = RUNTIME_START_TIMEOUT_MS,
          phase: 'startup' | 'visible-output' | 'continuation' = 'startup'
        ) => {
          clearFirstRuntimeEventTimer()
          firstRuntimeEventTimer = setTimeout(async () => {
            if (finished) return

            const timeoutSeconds = Math.round(timeoutMs / 1000)
            const timeoutError = new AgentRuntimeNoOutputTimeoutError(
              phase === 'startup'
                ? `The Agent runtime did not start within ${timeoutSeconds} seconds.`
                : phase === 'continuation'
                  ? `The Agent runtime stopped producing progress for ${timeoutSeconds} seconds while continuing the task.`
                  : `The Agent runtime started but did not produce a visible result within ${timeoutSeconds} seconds.`
            )
            logger.warn('Agent runtime timed out before visible output', {
              sessionId: session.id,
              runtimeId: activeRuntimeId,
              candidates: runtimeResolution.candidates,
              model: session.model,
              timeoutMs,
              phase
            })

            try {
              if (phase === 'continuation' && (await tryStreamRecovery(timeoutError))) return
              if (await tryFallback(timeoutError)) return
            } catch (fallbackError) {
              logger.error('Failed to start fallback runtime after timeout', fallbackError as Error)
            }

            cleanup()
            // Stop the runtime, not the HTTP transport: aborting the parent here
            // synchronously closes SSE before it can deliver this failure.
            activeRuntimeAbortController.abort(timeoutError)
            controller.error(timeoutError)
            rejectCompletion(serializeError(timeoutError))
          }, timeoutMs)
        }

        const startDeepResearchTaskTimer = () => {
          if (!req.deep_research && !req.deep_research_task) return

          deepResearchTimerRemainingMs = DEEP_RESEARCH_TASK_TIMEOUT_MS
          deepResearchTimerPaused = false

          const timeoutDeepResearchTask = () => {
            if (finished) return

            const timeoutError = new AgentDeepResearchTimeoutError(
              '深度研究已达到 8 分钟安全时限。已保留已完成的证据，请缩小研究范围后重试。'
            )
            logger.warn('Deep research task timed out', {
              sessionId: session.id,
              runtimeId: activeRuntimeId,
              model: session.model,
              timeoutMs: DEEP_RESEARCH_TASK_TIMEOUT_MS
            })
            cleanup()
            activeRuntimeAbortController.abort(timeoutError)
            controller.error(timeoutError)
            rejectCompletion(serializeError(timeoutError))
          }

          const scheduleDeepResearchTaskTimer = () => {
            clearDeepResearchTaskTimer()
            if (deepResearchTimerRemainingMs <= 0) {
              timeoutDeepResearchTask()
              return
            }

            deepResearchTimerStartedAt = Date.now()
            deepResearchTaskTimer = setTimeout(timeoutDeepResearchTask, deepResearchTimerRemainingMs)
          }

          const pauseDeepResearchTaskTimer = () => {
            if (deepResearchTimerPaused || deepResearchTimerStartedAt === undefined) return

            const elapsedMs = Math.max(0, Date.now() - deepResearchTimerStartedAt)
            deepResearchTimerRemainingMs = Math.max(0, deepResearchTimerRemainingMs - elapsedMs)
            clearDeepResearchTaskTimer()
            deepResearchTimerPaused = true
            logger.info('Paused deep research timer for browser handoff', {
              sessionId: session.id,
              remainingMs: deepResearchTimerRemainingMs
            })
          }

          const resumeDeepResearchTaskTimer = () => {
            if (!deepResearchTimerPaused || finished) return

            deepResearchTimerPaused = false
            scheduleDeepResearchTaskTimer()
            logger.info('Resumed deep research timer after browser handoff', {
              sessionId: session.id,
              remainingMs: deepResearchTimerRemainingMs
            })
          }

          scheduleDeepResearchTaskTimer()

          deepResearchTimerControls = {
            pause: pauseDeepResearchTaskTimer,
            resume: resumeDeepResearchTaskTimer
          }
        }

        const tryFallback = async (error: Error): Promise<boolean> => {
          const nextCandidate = runtimeResolution.candidates[activeCandidateIndex + 1]
          const canFallback =
            runtimeResolution.source === 'auto' &&
            !runtimeCommitted &&
            !fallbackAttempted &&
            Boolean(nextCandidate) &&
            shouldFallbackRuntime(error, abortController)

          if (!canFallback || !nextCandidate) return false

          fallbackAttempted = true
          clearFirstRuntimeEventTimer()
          agentStream.removeAllListeners()
          activeRuntimeAbortController.abort('switching to fallback runtime')
          activeRuntimeAbortController = new AbortController()
          if (abortController.signal.aborted) {
            activeRuntimeAbortController.abort(abortController.signal.reason ?? 'session stream aborted')
            return false
          }
          pendingRuntimeChunks = []
          runtimeStarted = false
          const previousRuntimeId = activeRuntimeId
          activeCandidateIndex += 1
          activeRuntimeId = nextCandidate
          recordMainDiagnostic(diagnosticId, 'runtime', 'fallback', {
            previousRuntimeId,
            fallbackRuntimeId: activeRuntimeId,
            error
          })

          logger.warn('Auto runtime failed before output; trying one fallback candidate', {
            sessionId: session.id,
            model: session.model,
            previousRuntimeId,
            fallbackRuntimeId: activeRuntimeId,
            error: error.message
          })

          agentStream = await getAgentRuntimeServiceById(activeRuntimeId).invoke(
            withAgentRecoveryContext(runtimePrompt, req.recovery_context),
            session,
            activeRuntimeAbortController,
            undefined,
            {
              effort: requestEffort,
              thinking: req.thinking,
              diagnosticId,
              recoveryContext: req.recovery_context
            },
            undefined
          )
          startFirstRuntimeEventTimer()
          attachRuntimeStream()
          return true
        }

        const tryContextRecovery = async (error: Error): Promise<boolean> => {
          if (activeRuntimeId === 'opencode') return false
          const canRecover =
            !runtimeCommitted &&
            !contextRecoveryAttempted &&
            !abortController.signal.aborted &&
            Boolean(req.recovery_context?.trim()) &&
            isRecoverableAgentContextError(error)

          if (!canRecover) return false

          contextRecoveryAttempted = true
          recordMainDiagnostic(diagnosticId, 'runtime', 'context-recovery', { error, runtime: activeRuntimeId })
          clearFirstRuntimeEventTimer()
          agentStream.removeAllListeners()
          activeRuntimeAbortController.abort('rebuilding runtime session context')
          activeRuntimeAbortController = new AbortController()
          if (abortController.signal.aborted) {
            activeRuntimeAbortController.abort(abortController.signal.reason ?? 'session stream aborted')
            return false
          }
          pendingRuntimeChunks = []
          runtimeStarted = false
          logger.warn('Agent runtime session was unavailable; rebuilding continuity from local context', {
            sessionId: session.id,
            runtimeId: activeRuntimeId,
            model: session.model,
            error: error.message
          })

          controller.enqueue({
            type: 'raw',
            rawValue: {
              type: 'context_recovery',
              status: 'retrying',
              runtime_id: activeRuntimeId
            }
          } as TextStreamPart<Record<string, any>>)
          agentStream = await getAgentRuntimeServiceById(activeRuntimeId).invoke(
            withAgentRecoveryContext(runtimePrompt, req.recovery_context),
            session,
            activeRuntimeAbortController,
            undefined,
            {
              effort: requestEffort,
              thinking: req.thinking,
              diagnosticId,
              recoveryContext: req.recovery_context
            },
            undefined
          )
          startFirstRuntimeEventTimer()
          attachRuntimeStream()
          return true
        }

        const tryStreamRecovery = async (error: Error): Promise<boolean> => {
          if (activeRuntimeId === 'opencode') return false
          const canRecover =
            !streamRecoveryAttempted &&
            !abortController.signal.aborted &&
            isRecoverableAgentTransportError(error, abortController)

          if (!canRecover) return false

          streamRecoveryAttempted = true
          recordMainDiagnostic(diagnosticId, 'runtime', 'stream-recovery', { error, runtime: activeRuntimeId })
          streamRecoveryActive = true
          streamRecoveryProducedProgress = false
          clearFirstRuntimeEventTimer()
          agentStream.removeAllListeners()
          activeRuntimeAbortController.abort('recovering agent after upstream stream failure')
          activeRuntimeAbortController = new AbortController()
          if (abortController.signal.aborted) {
            activeRuntimeAbortController.abort(abortController.signal.reason ?? 'session stream aborted')
            return false
          }

          pendingRuntimeChunks = []
          runtimeStarted = false
          pendingToolCalls.clear()
          const recoveryContext = [req.recovery_context, accumulator.getRecoveryContext()]
            .filter((value): value is string => Boolean(value?.trim()))
            .join('\n\n')

          logger.warn('Agent stream interrupted after progress; restarting from a local checkpoint', {
            sessionId: session.id,
            runtimeId: activeRuntimeId,
            model: session.model,
            error: error.message,
            hasToolActivity: accumulator.hasToolActivity()
          })

          controller.enqueue({
            type: 'raw',
            rawValue: {
              type: 'agent_stream_recovery',
              status: 'retrying',
              runtime_id: activeRuntimeId,
              reason: 'upstream_channel_failure',
              has_tool_activity: accumulator.hasToolActivity()
            }
          } as TextStreamPart<Record<string, any>>)

          agentStream = await getAgentRuntimeServiceById(activeRuntimeId).invoke(
            withAgentRecoveryContext(runtimePrompt, recoveryContext),
            session,
            activeRuntimeAbortController,
            undefined,
            {
              effort: requestEffort,
              thinking: req.thinking,
              diagnosticId,
              recoveryContext
            },
            undefined
          )
          startFirstRuntimeEventTimer(RUNTIME_VISIBLE_OUTPUT_TIMEOUT_MS, 'visible-output')
          attachRuntimeStream()
          return true
        }

        const handleRuntimeEvent = async (event: AgentStreamEvent) => {
          if (finished) return
          try {
            switch (event.type) {
              case 'chunk': {
                const chunk = event.chunk as TextStreamPart<Record<string, any>> | undefined
                if (!chunk) {
                  logger.warn('Received agent chunk event without chunk payload')
                  return
                }

                if (
                  activeRuntimeId === 'opencode' &&
                  chunk.type === 'raw' &&
                  (chunk.rawValue as { type?: string })?.type === 'opencode_status'
                ) {
                  const status = (chunk.rawValue as { status: string }).status
                  if (status === 'waiting_permission') {
                    clearFirstRuntimeEventTimer()
                    deepResearchTimerControls?.pause()
                  } else if (status === 'busy') {
                    deepResearchTimerControls?.resume()
                    if (!firstRuntimeEventTimer)
                      startFirstRuntimeEventTimer(RUNTIME_VISIBLE_OUTPUT_TIMEOUT_MS, 'visible-output')
                  }
                  controller.enqueue(chunk)
                  return
                }

                // AI SDK error parts are terminal. Converting them into a single
                // stream rejection prevents repeated error chunks from creating
                // multiple UI cards before the runtime emits its final event.
                if (chunk.type === 'error' || (chunk.type === 'finish' && chunk.finishReason === 'error')) {
                  const streamError =
                    chunk.type === 'error'
                      ? toStreamError(chunk.error)
                      : new Error('Agent runtime reported a failed response')
                  if (await tryContextRecovery(streamError)) return
                  if (await tryStreamRecovery(streamError)) return
                  if (await tryFallback(streamError)) return
                  cleanup()
                  controller.error(streamError)
                  rejectCompletion(serializeError(streamError))
                  break
                }

                if (streamRecoveryActive && isRuntimeBootstrapChunk(chunk)) {
                  // The replacement runtime has its own init/start events.
                  // They are internal and must not create a duplicate visible
                  // turn in the existing assistant message.
                  return
                }
                const hasProgress = isRuntimeProgressChunk(chunk)
                if (streamRecoveryActive && hasProgress) {
                  streamRecoveryActive = false
                  streamRecoveryProducedProgress = true
                }

                const toolName = (chunk as { toolName?: unknown }).toolName
                if (chunk.type === 'tool-call' && isBrowserWaitForUserTool(toolName)) {
                  const toolInput = (chunk as { input?: unknown }).input
                  const inputMessage =
                    toolInput &&
                    typeof toolInput === 'object' &&
                    'message' in toolInput &&
                    typeof toolInput.message === 'string'
                      ? toolInput.message.trim()
                      : ''
                  const scheduledTask = (session.configuration as Record<string, any> | undefined)?.scheduled_task
                  broadcastAgentActionRequired({
                    requestId: chunk.toolCallId,
                    agentId: session.agent_id,
                    sessionId: session.id,
                    taskId: typeof scheduledTask?.task_id === 'string' ? scheduledTask.task_id : undefined,
                    taskName: typeof scheduledTask?.task_name === 'string' ? scheduledTask.task_name : undefined,
                    reason: 'browser_handoff',
                    message:
                      inputMessage ||
                      '该任务需要你在浏览器中完成登录、验证码或确认操作。进入对应对话后完成操作，任务会继续执行。'
                  })
                  deepResearchTimerControls?.pause()
                } else if (
                  (chunk.type === 'tool-result' || chunk.type === 'tool-error') &&
                  isBrowserWaitForUserTool(toolName)
                ) {
                  deepResearchTimerControls?.resume()
                }

                if ((!runtimeCommitted || streamRecoveryActive) && !hasProgress) {
                  pendingRuntimeChunks.push(chunk)
                  // Bound metadata-only streams while retaining the latest frames.
                  if (pendingRuntimeChunks.length > 64) pendingRuntimeChunks.splice(2, 1)
                  if (!runtimeStarted) {
                    runtimeStarted = true
                    recordMainDiagnostic(diagnosticId, 'runtime', 'started', { runtime: activeRuntimeId })
                    startFirstRuntimeEventTimer(RUNTIME_VISIBLE_OUTPUT_TIMEOUT_MS, 'visible-output')
                  }
                  return
                }

                if (chunk.type === 'tool-call') pendingToolCalls.add(chunk.toolCallId)
                if (chunk.type === 'tool-result' || chunk.type === 'tool-error')
                  pendingToolCalls.delete(chunk.toolCallId)
                if (hasProgress) {
                  clearFirstRuntimeEventTimer()
                  // Do not time out tools or browser/user handoffs. Once tools
                  // finish, guard the next inference just like the first one.
                  if (pendingToolCalls.size === 0 && !req.deep_research && !req.deep_research_task) {
                    startFirstRuntimeEventTimer(RUNTIME_VISIBLE_OUTPUT_TIMEOUT_MS, 'continuation')
                  }
                }
                for (const pendingChunk of pendingRuntimeChunks) {
                  accumulator.add(pendingChunk)
                  controller.enqueue(pendingChunk)
                }
                pendingRuntimeChunks = []
                if (!runtimeCommitted)
                  recordMainDiagnostic(diagnosticId, 'runtime', 'visible-output', { runtime: activeRuntimeId })
                if (chunk.type === 'tool-call' || chunk.type === 'tool-error' || chunk.type === 'tool-result') {
                  recordMainDiagnostic(diagnosticId, 'tool', chunk.type, {
                    toolName: chunk.toolName,
                    toolCallId: chunk.toolCallId,
                    ...(chunk.type === 'tool-error' ? { error: chunk.error } : {})
                  })
                }
                runtimeCommitted = true
                accumulator.add(chunk)
                controller.enqueue(chunk)
                break
              }

              case 'error': {
                clearFirstRuntimeEventTimer()
                const stderrMessage = (event as any)?.data?.stderr as string | undefined
                const underlyingError = event.error ?? (stderrMessage ? new Error(stderrMessage) : undefined)
                const streamError = toStreamError(underlyingError)
                if (await tryContextRecovery(streamError)) return
                if (await tryStreamRecovery(streamError)) return
                if (await tryFallback(streamError)) return
                cleanup()
                controller.error(streamError)
                rejectCompletion(serializeError(streamError))
                break
              }

              case 'complete': {
                clearFirstRuntimeEventTimer()
                if (streamRecoveryActive && !streamRecoveryProducedProgress) {
                  const emptyRecoveryError = new Error(
                    '备用线路已连接，但恢复任务没有产生新的进展。为避免重复执行，已停止自动恢复。'
                  )
                  cleanup()
                  controller.error(emptyRecoveryError)
                  rejectCompletion(serializeError(emptyRecoveryError))
                  return
                }
                if (!runtimeCommitted || (!accumulator.getText().trim() && !accumulator.hasToolActivity())) {
                  const emptyResultError = new Error('Agent runtime completed before producing a user-visible result')
                  if (await tryContextRecovery(emptyResultError)) return
                  if (await tryFallback(emptyResultError)) return
                  cleanup()
                  controller.error(emptyResultError)
                  rejectCompletion(serializeError(emptyResultError))
                  return
                }
                for (const pendingChunk of pendingRuntimeChunks) {
                  accumulator.add(pendingChunk)
                  controller.enqueue(pendingChunk)
                }
                pendingRuntimeChunks = []
                cleanup()
                const assistantText = accumulator.getText()
                recordMainDiagnostic(diagnosticId, 'runtime', 'complete', {
                  runtime: activeRuntimeId,
                  outputCharacters: assistantText.length
                })
                if (options?.mirrorToBoundChannel) {
                  this.mirrorSessionExchangeToBoundChannel(
                    session,
                    options?.displayContent ?? req.content,
                    accumulator.snapshot().finalText || assistantText,
                    false,
                    automationOutputPaths(
                      accumulator.snapshot().tools.map((tool) => ({
                        type: 'tool',
                        metadata: {
                          rawMcpToolResponse: {
                            status: tool.failed ? 'error' : 'done',
                            tool: { name: tool.toolName },
                            response: tool.output
                          }
                        }
                      }))
                    ),
                    mirrorContext
                  )
                    .then((result) => {
                      controller.enqueue({
                        type: 'raw',
                        rawValue: {
                          type: 'agent_session_sync',
                          target: result.target,
                          status: result.status,
                          runId: result.runId,
                          reason: result.reason
                        }
                      } as TextStreamPart<Record<string, any>>)
                    })
                    .catch((error) => {
                      logger.warn('Failed to mirror session exchange to bound channel', {
                        sessionId: session.id,
                        error: error instanceof Error ? error.message : String(error)
                      })
                      controller.enqueue({
                        type: 'raw',
                        rawValue: {
                          type: 'agent_session_sync',
                          target: 'wechat',
                          status: 'failed',
                          reason: error instanceof Error ? error.message : String(error)
                        }
                      } as TextStreamPart<Record<string, any>>)
                    })
                    .finally(() => {
                      controller.close()
                    })
                } else {
                  controller.close()
                }
                if (options?.persist) {
                  // Read SDK session_id from the stream object (set by ClaudeCodeService on init)
                  const resolvedSessionId = agentStream.sdkSessionId || agentSessionId
                  logger.debug('Persisting headless exchange with agent session ID', {
                    runtimeId: activeRuntimeId,
                    sdkSessionId: agentStream.sdkSessionId,
                    fallback: agentSessionId,
                    resolved: resolvedSessionId
                  })
                  this.persistHeadlessExchange(
                    session,
                    options?.displayContent ?? req.content,
                    accumulator.getText(),
                    resolvedSessionId,
                    options?.images,
                    options?.persistenceId,
                    accumulator.snapshot(),
                    'success',
                    options.files
                  )
                    .then(resolveCompletion)
                    .catch((err) => {
                      logger.error('Failed to persist headless exchange', err as Error)
                      if (options.strictPersistence) rejectCompletion(err)
                      else resolveCompletion({})
                    })
                } else {
                  resolveCompletion({})
                }
                break
              }

              case 'cancelled': {
                clearFirstRuntimeEventTimer()
                cleanup()
                controller.enqueue({ type: 'abort' })
                const partialText = accumulator.getText()
                if (options?.mirrorToBoundChannel) {
                  this.mirrorSessionExchangeToBoundChannel(
                    session,
                    options?.displayContent ?? req.content,
                    partialText,
                    true,
                    [],
                    mirrorContext
                  )
                    .then((result) => {
                      controller.enqueue({
                        type: 'raw',
                        rawValue: {
                          type: 'agent_session_sync',
                          target: result.target,
                          status: result.status,
                          runId: result.runId,
                          reason: result.reason
                        }
                      } as TextStreamPart<Record<string, any>>)
                    })
                    .catch((error) => {
                      logger.warn('Failed to mirror cancelled session exchange to bound channel', {
                        sessionId: session.id,
                        error: error instanceof Error ? error.message : String(error)
                      })
                      controller.enqueue({
                        type: 'raw',
                        rawValue: {
                          type: 'agent_session_sync',
                          target: 'wechat',
                          status: 'failed',
                          reason: error instanceof Error ? error.message : String(error)
                        }
                      } as TextStreamPart<Record<string, any>>)
                    })
                    .finally(() => {
                      controller.close()
                    })
                } else {
                  controller.close()
                }
                if (options?.persist) {
                  const resolvedSessionId = agentStream.sdkSessionId || agentSessionId
                  if (partialText || options.persistenceId) {
                    this.persistHeadlessExchange(
                      session,
                      options?.displayContent ?? req.content,
                      partialText,
                      resolvedSessionId,
                      options?.images,
                      options?.persistenceId,
                      accumulator.snapshot(),
                      'paused',
                      options.files
                    )
                      .then(resolveCompletion)
                      .catch((err) => {
                        logger.error('Failed to persist cancelled exchange', err as Error)
                        if (options.strictPersistence) rejectCompletion(err)
                        else resolveCompletion({})
                      })
                  } else {
                    resolveCompletion({})
                  }
                } else {
                  resolveCompletion({})
                }
                break
              }

              default:
                logger.warn('Unknown event type from Claude Code service:', {
                  type: event.type
                })
                break
            }
          } catch (error) {
            cleanup()
            controller.error(error)
            rejectCompletion(serializeError(error))
          }
        }

        function attachRuntimeStream() {
          const attachedStream = agentStream
          let eventQueue = Promise.resolve()
          attachedStream.on('data', (event: AgentStreamEvent) => {
            // SDKs can emit error + finish in the same tick. Finish must wait
            // for recovery, and events from a replaced runtime must be ignored.
            eventQueue = eventQueue
              .then(async () => {
                if (finished || agentStream !== attachedStream) return
                await handleRuntimeEvent(event)
              })
              .catch((error) => {
                if (finished) return
                cleanup()
                controller.error(error)
                rejectCompletion(serializeError(error))
              })
          })
        }

        startDeepResearchTaskTimer()
        startFirstRuntimeEventTimer()
        attachRuntimeStream()
      },
      cancel: (reason) => {
        abortController.abort(typeof reason === 'string' ? reason : 'stream cancelled')
        // The HTTP abort listener can synchronously cancel this reader before
        // dispatch reaches forwardParentAbort. Forward explicitly before cleanup
        // removes that listener, even when the parent signal is already aborted.
        forwardParentAbort()
        cleanup()
        resolveCompletion({})
      }
    })

    return { stream, completion }
  }

  /**
   * Persist user + assistant messages for headless callers (channels, scheduler)
   * that have no UI to handle persistence via IPC.
   */
  private async persistHeadlessExchange(
    session: GetAgentSessionResponse,
    userContent: string,
    assistantContent: string,
    agentSessionId: string,
    images?: Array<{ data: string; media_type: string }>,
    persistenceId?: string,
    snapshot?: ReturnType<TextStreamAccumulator['snapshot']>,
    status: 'success' | 'paused' | 'error' = 'success',
    files: FileMetadata[] = []
  ): Promise<{ userMessage?: AgentSessionMessageEntity; assistantMessage?: AgentSessionMessageEntity }> {
    const now = new Date().toISOString()
    const userMsgId = persistenceId ? `${persistenceId}:user` : randomUUID()
    const assistantMsgId = persistenceId ? `${persistenceId}:assistant` : randomUUID()
    const userBlockId = randomUUID()
    const assistantBlockId = randomUUID()
    const topicId = `agent-session:${session.id}`
    const separator = session.model.indexOf(':')
    const modelId = separator >= 0 ? session.model.slice(separator + 1) : session.model

    // Build image blocks for user message
    const imageBlocks: Array<{
      id: string
      messageId: string
      type: string
      createdAt: string
      status: string
      url: string
    }> = []
    if (images && images.length > 0) {
      for (const img of images) {
        imageBlocks.push({
          id: randomUUID(),
          messageId: userMsgId,
          type: 'image',
          createdAt: now,
          status: 'success',
          url: `data:${img.media_type};base64,${img.data}`
        })
      }
    }

    const fileBlocks = headlessAttachmentBlocks(files, userMsgId, now)
    const userPayload = {
      message: {
        id: userMsgId,
        role: 'user' as const,
        assistantId: session.agent_id,
        topicId,
        createdAt: snapshot?.responseTiming?.startedAt ?? now,
        status: 'success',
        blocks: [userBlockId, ...imageBlocks.map((b) => b.id), ...fileBlocks.map((b) => b.id)]
      },
      blocks: [
        {
          id: userBlockId,
          messageId: userMsgId,
          type: 'main_text',
          createdAt: now,
          status: 'success',
          content: userContent
        },
        ...imageBlocks,
        ...fileBlocks
      ]
    } as AgentPersistedMessage

    const assistantPayload = {
      message: {
        id: assistantMsgId,
        role: 'assistant' as const,
        assistantId: session.agent_id,
        topicId,
        createdAt: now,
        status: 'success',
        blocks: [assistantBlockId],
        modelId,
        model: {
          id: modelId,
          name: modelId,
          provider: separator >= 0 ? session.model.slice(0, separator) : '',
          group: ''
        }
      },
      blocks: [
        {
          id: assistantBlockId,
          messageId: assistantMsgId,
          type: 'main_text',
          createdAt: now,
          status: 'success',
          content: assistantContent
        }
      ]
    } as AgentPersistedMessage

    assistantPayload.message.status = status as typeof assistantPayload.message.status
    if (snapshot) {
      const turn = snapshot.turn as { user_message_id?: string; session_id?: string } | undefined
      userPayload.message.providerMetadata = { opencode: turn } as any
      assistantPayload.message.askId = userMsgId
      assistantPayload.message.agentSessionId = agentSessionId
      userPayload.message.agentSessionId = agentSessionId
      assistantPayload.message.providerMetadata = {
        zenAutomation: {
          persistenceId,
          finalText: snapshot.finalText,
          diagnosticId: persistenceId ? `automation-${persistenceId}` : undefined
        },
        opencodeDiagnostics: snapshot.diagnostics,
        responseTiming: snapshot.responseTiming
          ? {
              ...snapshot.responseTiming,
              outcome: status === 'paused' ? 'cancelled' : status === 'error' ? 'failed' : 'completed'
            }
          : undefined
      } as any
      if (snapshot.usage) {
        const usage = snapshot.usage as {
          inputTokens?: number
          outputTokens?: number
          inputTokenDetails?: { cacheReadTokens?: number }
        }
        assistantPayload.message.usage = {
          prompt_tokens: usage.inputTokens || 0,
          completion_tokens: usage.outputTokens || 0,
          total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
          prompt_tokens_details: { cached_tokens: usage.inputTokenDetails?.cacheReadTokens || 0 }
        }
      }
      for (const tool of snapshot.tools) {
        const id = `${assistantMsgId}:tool:${tool.id}`
        assistantPayload.message.blocks.push(id)
        assistantPayload.blocks.push({
          id,
          messageId: assistantMsgId,
          type: 'tool',
          createdAt: now,
          status: tool.failed ? 'error' : 'success',
          metadata: {
            rawMcpToolResponse: {
              status: tool.failed ? 'error' : 'done',
              tool: { id: tool.toolName, name: tool.toolName },
              response: tool.output
            }
          }
        } as any)
      }
    }

    const result = await agentMessageRepository.persistExchange({
      sessionId: session.id,
      agentSessionId,
      user: { payload: userPayload, createdAt: now },
      assistant: { payload: assistantPayload, createdAt: now }
    })

    logger.info('Persisted headless exchange', {
      sessionId: session.id,
      userMessageId: userMsgId,
      assistantMessageId: assistantMsgId
    })

    return result
  }

  private async mirrorSessionExchangeToBoundChannel(
    session: GetAgentSessionResponse,
    userContent: string,
    assistantContent: string,
    stopped = false,
    files: string[] = [],
    context?: AutomationMirrorContext
  ): Promise<SessionMirrorResult> {
    const mirrored = await mirrorAutomationExchange(session.id, userContent, assistantContent, stopped, files, context)
    return {
      target: 'wechat',
      status: mirrored === false ? 'skipped' : 'synced',
      ...(mirrored && typeof mirrored === 'object' ? { runId: mirrored.runId } : {})
    }
  }

  private async getLastAgentSessionId(sessionId: string, modelId?: string): Promise<string> {
    if (!modelId) {
      return ''
    }

    try {
      const database = await this.getDatabase()
      const result = await database
        .select({
          agent_session_id: sessionMessagesTable.agent_session_id,
          content: sessionMessagesTable.content
        })
        .from(sessionMessagesTable)
        .where(
          and(
            eq(sessionMessagesTable.session_id, sessionId),
            eq(sessionMessagesTable.role, 'assistant'),
            not(eq(sessionMessagesTable.agent_session_id, ''))
          )
        )
        .orderBy(desc(sessionMessagesTable.created_at))
        .limit(20)

      const agentSessionId = findCompatibleAgentSessionId(result, modelId)

      logger.silly('Last compatible agent session ID result:', {
        agentSessionId,
        sessionId,
        modelId
      })
      return agentSessionId
    } catch (error) {
      logger.error('Failed to get last agent session ID', {
        sessionId,
        error
      })
      return ''
    }
  }

  private deserializeSessionMessage(data: any): AgentSessionMessageEntity {
    if (!data) return data

    const deserialized = { ...data }

    // Parse content JSON
    if (deserialized.content && typeof deserialized.content === 'string') {
      try {
        deserialized.content = JSON.parse(deserialized.content)
      } catch (error) {
        logger.warn(`Failed to parse content JSON:`, error as Error)
      }
    }

    // Parse metadata JSON
    if (deserialized.metadata && typeof deserialized.metadata === 'string') {
      try {
        deserialized.metadata = JSON.parse(deserialized.metadata)
      } catch (error) {
        logger.warn(`Failed to parse metadata JSON:`, error as Error)
      }
    }

    return deserialized
  }
}

export const sessionMessageService = SessionMessageService.getInstance()
