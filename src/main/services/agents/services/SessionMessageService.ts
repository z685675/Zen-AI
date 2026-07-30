import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
import type {
  AgentPersistedMessage,
  AgentSessionMessageEntity,
  CreateSessionMessageRequest,
  GetAgentSessionResponse,
  ListOptions
} from '@types'
import type { TextStreamPart } from 'ai'
import { and, desc, eq, not } from 'drizzle-orm'

import { BaseService } from '../BaseService'
import { sessionMessagesTable } from '../database/schema'
import { agentMessageRepository } from '../database/sessionMessageRepository'
import type { AgentStream, AgentStreamEvent } from '../interfaces/AgentStreamInterface'
import { channelManager } from './channels/ChannelManager'
import { channelService } from './ChannelService'
import { isRecoverableAgentContextError, withAgentRecoveryContext } from './runtime/contextRecovery'
import { AgentRuntimeNoOutputTimeoutError, isRuntimeBootstrapChunk, shouldFallbackRuntime } from './runtime/fallback'
import { getAgentRuntimeServiceById, resolveAgentRuntime } from './runtime/registry'
import { findCompatibleAgentSessionId } from './runtime/resume'

const logger = loggerService.withContext('SessionMessageService')
const RUNTIME_START_TIMEOUT_MS = 45_000
const RUNTIME_VISIBLE_OUTPUT_TIMEOUT_MS = 180_000

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
}

export type CreateMessageOptions = {
  /** When true, persist user+assistant messages to DB on stream complete. Use for headless callers (channels, scheduler) where no UI handles persistence. */
  persist?: boolean
  /** Optional display-safe user content for persistence. When set, this is stored instead of req.content (which may contain security wrappers not meant for display). */
  displayContent?: string
  /** Images to persist in the user message for UI display (not sent to AI model). */
  images?: Array<{ data: string; media_type: string }>
  /** Mirror desktop-side user/assistant text back to a bound external channel when applicable. */
  mirrorToBoundChannel?: boolean
}

// Ensure errors emitted through SSE are serializable
function serializeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack
    }
  }

  if (typeof error === 'string') {
    return { message: error }
  }

  return {
    message: 'Unknown error'
  }
}

function toStreamError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  if (typeof error === 'string') {
    return new Error(error)
  }

  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return new Error(error.message)
  }

  return new Error('Stream error')
}

class TextStreamAccumulator {
  private textBuffer = ''
  private totalText = ''
  private readonly toolCalls = new Map<string, { toolName?: string; input?: unknown }>()
  private readonly toolResults = new Map<string, unknown>()

  add(part: TextStreamPart<Record<string, any>>): void {
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
        }
        this.textBuffer = ''
        break
      }
      case 'tool-call':
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
      default:
        break
    }
  }

  getText(): string {
    return (this.totalText + this.textBuffer).replace(/\n+$/, '')
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
    const database = await this.getDatabase()
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
    return await this.startSessionMessageStream(session, messageData, abortController, options)
  }

  private async startSessionMessageStream(
    session: GetAgentSessionResponse,
    req: CreateSessionMessageRequest,
    abortController: AbortController,
    options?: CreateMessageOptions
  ): Promise<SessionStreamResult> {
    const runtimeResolution = await resolveAgentRuntime(session)
    const agentSessionId = await this.getLastAgentSessionId(session.id, session.model)
    logger.debug('Session Message stream message data:', {
      message: req,
      session_id: agentSessionId,
      runtime_id: runtimeResolution.runtimeId,
      model: session.model
    })

    let activeRuntimeId = runtimeResolution.runtimeId
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

    const initialPrompt = agentSessionId ? req.content : withAgentRecoveryContext(req.content, req.recovery_context)
    let agentStream: AgentStream
    try {
      agentStream = await getAgentRuntimeServiceById(activeRuntimeId).invoke(
        initialPrompt,
        session,
        activeRuntimeAbortController,
        agentSessionId,
        {
          effort: req.effort,
          thinking: req.thinking,
          recoveryContext: req.recovery_context
        },
        undefined
      )
    } catch (error) {
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
    const accumulator = new TextStreamAccumulator()

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
      rejectCompletion = reject
    })

    let finished = false
    let runtimeCommitted = false
    let fallbackAttempted = false
    let contextRecoveryAttempted = false
    let runtimeStarted = false
    let pendingRuntimeChunks: TextStreamPart<Record<string, any>>[] = []
    let firstRuntimeEventTimer: ReturnType<typeof setTimeout> | undefined

    const clearFirstRuntimeEventTimer = () => {
      if (!firstRuntimeEventTimer) return
      clearTimeout(firstRuntimeEventTimer)
      firstRuntimeEventTimer = undefined
    }

    const cleanup = () => {
      if (finished) return
      finished = true
      clearFirstRuntimeEventTimer()
      abortController.signal.removeEventListener('abort', forwardParentAbort)
      agentStream.removeAllListeners()
    }

    const stream = new ReadableStream<TextStreamPart<Record<string, any>>>({
      start: (controller) => {
        const startFirstRuntimeEventTimer = (
          timeoutMs = RUNTIME_START_TIMEOUT_MS,
          phase: 'startup' | 'visible-output' = 'startup'
        ) => {
          clearFirstRuntimeEventTimer()
          firstRuntimeEventTimer = setTimeout(async () => {
            if (finished) return

            const timeoutSeconds = Math.round(timeoutMs / 1000)
            const timeoutError = new AgentRuntimeNoOutputTimeoutError(
              phase === 'startup'
                ? `The Agent runtime did not start within ${timeoutSeconds} seconds.`
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
              if (await tryFallback(timeoutError)) return
            } catch (fallbackError) {
              logger.error('Failed to start fallback runtime after timeout', fallbackError as Error)
            }

            cleanup()
            activeRuntimeAbortController.abort(`agent runtime ${phase} timeout`)
            abortController.abort(`agent runtime ${phase} timeout`)
            controller.error(timeoutError)
            rejectCompletion(serializeError(timeoutError))
          }, timeoutMs)
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

          logger.warn('Auto runtime failed before output; trying one fallback candidate', {
            sessionId: session.id,
            model: session.model,
            previousRuntimeId,
            fallbackRuntimeId: activeRuntimeId,
            error: error.message
          })

          agentStream = await getAgentRuntimeServiceById(activeRuntimeId).invoke(
            withAgentRecoveryContext(req.content, req.recovery_context),
            session,
            activeRuntimeAbortController,
            undefined,
            {
              effort: req.effort,
              thinking: req.thinking,
              recoveryContext: req.recovery_context
            },
            undefined
          )
          startFirstRuntimeEventTimer()
          attachRuntimeStream()
          return true
        }

        const tryContextRecovery = async (error: Error): Promise<boolean> => {
          const canRecover =
            !runtimeCommitted &&
            !contextRecoveryAttempted &&
            !abortController.signal.aborted &&
            Boolean(req.recovery_context?.trim()) &&
            isRecoverableAgentContextError(error)

          if (!canRecover) return false

          contextRecoveryAttempted = true
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
            withAgentRecoveryContext(req.content, req.recovery_context),
            session,
            activeRuntimeAbortController,
            undefined,
            {
              effort: req.effort,
              thinking: req.thinking,
              recoveryContext: req.recovery_context
            },
            undefined
          )
          startFirstRuntimeEventTimer()
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

                // AI SDK error parts are terminal. Converting them into a single
                // stream rejection prevents repeated error chunks from creating
                // multiple UI cards before the runtime emits its final event.
                if (chunk.type === 'error') {
                  const streamError = toStreamError(chunk.error)
                  if (await tryContextRecovery(streamError)) return
                  if (await tryFallback(streamError)) return
                  cleanup()
                  controller.error(streamError)
                  rejectCompletion(serializeError(streamError))
                  break
                }

                if (!runtimeCommitted && isRuntimeBootstrapChunk(chunk)) {
                  pendingRuntimeChunks.push(chunk)
                  if (!runtimeStarted) {
                    runtimeStarted = true
                    startFirstRuntimeEventTimer(RUNTIME_VISIBLE_OUTPUT_TIMEOUT_MS, 'visible-output')
                  }
                  return
                }

                clearFirstRuntimeEventTimer()
                for (const pendingChunk of pendingRuntimeChunks) {
                  accumulator.add(pendingChunk)
                  controller.enqueue(pendingChunk)
                }
                pendingRuntimeChunks = []
                runtimeCommitted = true
                accumulator.add(chunk)
                controller.enqueue(chunk)
                break
              }

              case 'error': {
                clearFirstRuntimeEventTimer()
                const stderrMessage = (event as any)?.data?.stderr as string | undefined
                const underlyingError = event.error ?? (stderrMessage ? new Error(stderrMessage) : undefined)
                const streamError = underlyingError ?? new Error('Stream error')
                if (await tryContextRecovery(streamError)) return
                if (await tryFallback(streamError)) return
                cleanup()
                controller.error(streamError)
                rejectCompletion(serializeError(streamError))
                break
              }

              case 'complete': {
                clearFirstRuntimeEventTimer()
                if (!runtimeCommitted) {
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
                if (options?.mirrorToBoundChannel) {
                  this.mirrorSessionExchangeToBoundChannel(
                    session,
                    options?.displayContent ?? req.content,
                    assistantText
                  )
                    .then((result) => {
                      controller.enqueue({
                        type: 'raw',
                        rawValue: {
                          type: 'agent_session_sync',
                          target: result.target,
                          status: result.status,
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
                    options?.images
                  )
                    .then(resolveCompletion)
                    .catch((err) => {
                      logger.error('Failed to persist headless exchange', err as Error)
                      resolveCompletion({})
                    })
                } else {
                  resolveCompletion({})
                }
                break
              }

              case 'cancelled': {
                clearFirstRuntimeEventTimer()
                cleanup()
                const partialText = accumulator.getText()
                if (options?.mirrorToBoundChannel && partialText) {
                  this.mirrorSessionExchangeToBoundChannel(session, options?.displayContent ?? req.content, partialText)
                    .then((result) => {
                      controller.enqueue({
                        type: 'raw',
                        rawValue: {
                          type: 'agent_session_sync',
                          target: result.target,
                          status: result.status,
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
                  if (partialText) {
                    this.persistHeadlessExchange(
                      session,
                      options?.displayContent ?? req.content,
                      partialText,
                      resolvedSessionId,
                      options?.images
                    )
                      .then(resolveCompletion)
                      .catch((err) => {
                        logger.error('Failed to persist cancelled exchange', err as Error)
                        resolveCompletion({})
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
          agentStream.on('data', handleRuntimeEvent)
        }

        startFirstRuntimeEventTimer()
        attachRuntimeStream()
      },
      cancel: (reason) => {
        abortController.abort(typeof reason === 'string' ? reason : 'stream cancelled')
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
    images?: Array<{ data: string; media_type: string }>
  ): Promise<{ userMessage?: AgentSessionMessageEntity; assistantMessage?: AgentSessionMessageEntity }> {
    const now = new Date().toISOString()
    const userMsgId = randomUUID()
    const assistantMsgId = randomUUID()
    const userBlockId = randomUUID()
    const assistantBlockId = randomUUID()
    const topicId = `agent-session:${session.id}`

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

    const userPayload = {
      message: {
        id: userMsgId,
        role: 'user' as const,
        assistantId: session.agent_id,
        topicId,
        createdAt: now,
        status: 'success',
        blocks: [userBlockId, ...imageBlocks.map((b) => b.id)]
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
        ...imageBlocks
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
        modelId: session.model
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
    assistantContent: string
  ): Promise<SessionMirrorResult> {
    const boundChannel = await channelService.findBySessionId(session.id)
    if (!boundChannel || !boundChannel.isActive || boundChannel.type !== 'wechat') {
      return { target: 'wechat', status: 'skipped', reason: 'not_bound' }
    }

    const adapter = channelManager.getAdapter(boundChannel.id)
    if (!adapter) {
      return { target: 'wechat', status: 'failed', reason: 'adapter_unavailable' }
    }

    const targetChatId = boundChannel.activeChatIds?.[0] ?? adapter.notifyChatIds?.[0]
    if (!targetChatId) {
      return { target: 'wechat', status: 'failed', reason: 'chat_unavailable' }
    }

    const normalizedUserContent = userContent.trim()
    const normalizedAssistantContent = assistantContent.trim()

    if (normalizedUserContent) {
      await adapter.sendMessage(targetChatId, `桌面端消息：\n${normalizedUserContent}`)
    }

    if (normalizedAssistantContent) {
      await adapter.sendMessage(targetChatId, normalizedAssistantContent)
    }

    return { target: 'wechat', status: 'synced' }
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
