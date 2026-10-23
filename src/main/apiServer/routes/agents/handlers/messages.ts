import { loggerService } from '@logger'
import { MESSAGE_STREAM_TIMEOUT_MS } from '@main/apiServer/config/timeouts'
import {
  createStreamAbortController,
  STREAM_TIMEOUT_REASON,
  type StreamAbortController
} from '@main/apiServer/utils/createStreamAbortController'
import { agentService, sessionMessageService, sessionService } from '@main/services/agents'
import { recordMainDiagnostic } from '@main/services/DiagnosticEvidenceService'
import {
  isAssistantExecutionAllowed,
  LEGACY_ASSISTANT_READ_ONLY_CODE,
  LEGACY_ASSISTANT_READ_ONLY_MESSAGE
} from '@shared/agents/assistantAvailability'
import { serializeAgentStreamError } from '@shared/agents/streamError'
import { getAgentTaskLimitDetails } from '@shared/agents/taskConcurrency'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { sanitizeDiagnostic } from '@shared/diagnostics'
import type { Request, Response } from 'express'

const logger = loggerService.withContext('ApiServerMessagesHandlers')

const errorEvent = (error: unknown, type = 'stream_error', code = 'stream_processing_failed') => {
  const details = serializeAgentStreamError(error, 'Stream processing error')
  return { type: 'error', error: { ...details, type, code: details.code ?? code } }
}

const isResponseWritable = (res: Response): boolean => !res.destroyed && !res.writableEnded && !res.writableFinished

const writeSse = (res: Response, payload: string): boolean => {
  if (!isResponseWritable(res)) {
    return false
  }

  try {
    res.write(payload)
    return true
  } catch (error) {
    logger.warn('Failed to write SSE payload', { error })
    return false
  }
}

const endResponse = (res: Response): void => {
  if (!isResponseWritable(res)) {
    return
  }

  try {
    res.end()
  } catch (error) {
    logger.warn('Failed to end SSE response', { error })
  }
}

// Helper function to verify agent and session exist and belong together
const verifyAgentAndSession = async (agentId: string, sessionId: string) => {
  const agentExists = await agentService.agentExists(agentId)
  if (!agentExists) {
    throw { status: 404, code: 'agent_not_found', message: 'Agent not found' }
  }

  const session = await sessionService.getSession(agentId, sessionId)
  if (!session) {
    throw { status: 404, code: 'session_not_found', message: 'Session not found' }
  }

  if (session.agent_id !== agentId) {
    throw { status: 404, code: 'session_not_found', message: 'Session not found for this agent' }
  }

  return session
}

export const createMessage = async (req: Request, res: Response): Promise<void> => {
  let streamController: StreamAbortController | undefined
  const requestedDiagnosticId = req.get('X-Zen-Diagnostic-Operation')
  const diagnosticId =
    requestedDiagnosticId && /^[\w.-]{1,128}$/.test(requestedDiagnosticId) ? requestedDiagnosticId : undefined
  let sessionVerified = false

  try {
    const { agentId, sessionId } = req.params

    const session = await verifyAgentAndSession(agentId, sessionId)
    sessionVerified = true

    if (!isAssistantExecutionAllowed(session.agent_id)) {
      res.status(410).json({
        error: {
          code: LEGACY_ASSISTANT_READ_ONLY_CODE,
          type: 'read_only',
          message: LEGACY_ASSISTANT_READ_ONLY_MESSAGE
        }
      })
      return
    }

    const messageData = req.body

    logger.info('Creating streaming message', { agentId, sessionId })
    logger.debug('Streaming message payload', { messageData })

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Cache-Control')

    streamController = createStreamAbortController({
      timeoutMs: MESSAGE_STREAM_TIMEOUT_MS
    })
    const { abortController, registerAbortHandler, dispose } = streamController
    const { stream, completion } = await sessionMessageService.createSessionMessage(
      session,
      messageData,
      abortController,
      {
        mirrorToBoundChannel: true,
        displayContent: messageData.content,
        diagnosticId
      }
    )
    const reader = stream.getReader()

    // Track both lifecycles so the SSE connection stays open for post-stream events
    // such as desktop-to-WeChat sync status before we send the final [DONE].
    let responseEnded = false
    let streamFinished = false
    let completionFinished = false

    const cleanup = () => {
      dispose()
    }

    const finalizeResponse = () => {
      if (responseEnded) {
        return
      }

      if (!streamFinished || !completionFinished) {
        return
      }

      responseEnded = true
      cleanup()
      try {
        // res.write('data: {"type":"finish"}\n\n')
        writeSse(res, 'data: [DONE]\n\n')
      } catch (writeError) {
        logger.error('Error writing final sentinel to SSE stream', { error: writeError as Error })
      }
      endResponse(res)
    }

    /**
     * Client Disconnect Detection for Server-Sent Events (SSE)
     *
     * We monitor multiple HTTP events to reliably detect when a client disconnects
     * from the streaming response. This is crucial for:
     * - Aborting long-running Claude Code processes
     * - Cleaning up resources and preventing memory leaks
     * - Avoiding orphaned processes
     *
     * Event Priority & Behavior:
     * 1. res.on('close') - Most common for SSE client disconnects (browser tab close, curl Ctrl+C)
     * 2. req.on('aborted') - Explicit request abortion
     * 3. req.on('close') - Request object closure (less common with SSE)
     *
     * When any disconnect event fires, we:
     * - Abort the Claude Code SDK process via abortController
     * - Clean up event listeners to prevent memory leaks
     * - Mark the response as ended to prevent further writes
     */
    registerAbortHandler((abortReason) => {
      cleanup()

      if (responseEnded) return

      responseEnded = true

      if (abortReason === STREAM_TIMEOUT_REASON) {
        logger.error('Streaming message timeout', { agentId, sessionId })
        try {
          writeSse(
            res,
            `data: ${JSON.stringify({
              type: 'error',
              error: {
                message: 'Stream timeout',
                type: 'timeout_error',
                code: 'stream_timeout'
              }
            })}\n\n`
          )
        } catch (writeError) {
          logger.error('Error writing timeout to SSE stream', { error: writeError })
        }
      } else if (abortReason === 'Client disconnected') {
        logger.info('Streaming client disconnected', { agentId, sessionId })
      } else if (abortReason instanceof Error && abortReason.name !== 'AbortError') {
        writeSse(res, `data: ${JSON.stringify(errorEvent(abortReason))}\n\n`)
      } else {
        writeSse(res, `data: ${JSON.stringify({ type: 'abort' })}\n\n`)
        logger.warn('Streaming aborted', { agentId, sessionId, reason: sanitizeDiagnostic(abortReason) })
      }

      reader.cancel(abortReason ?? 'stream aborted').catch(() => {})

      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
      }

      endResponse(res)
    })

    const handleDisconnect = () => {
      if (abortController.signal.aborted) return
      abortController.abort('Client disconnected')
    }

    req.on('close', handleDisconnect)
    req.on('aborted', handleDisconnect)
    res.on('close', handleDisconnect)

    const pumpStream = async () => {
      try {
        while (!responseEnded) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }

          if (!writeSse(res, `data: ${JSON.stringify(value)}\n\n`)) {
            responseEnded = true
            cleanup()
            reader.cancel('SSE response closed').catch(() => {})
            break
          }
        }

        streamFinished = true
        finalizeResponse()
      } catch (error) {
        if (responseEnded) return
        logger.error('Error reading agent stream', { error: sanitizeDiagnostic(error) })
        try {
          writeSse(res, `data: ${JSON.stringify(errorEvent(error))}\n\n`)
        } catch (writeError) {
          logger.error('Error writing stream error to SSE', { error: writeError })
        }
        responseEnded = true
        cleanup()
        endResponse(res)
      }
    }

    pumpStream().catch((error) => {
      logger.error('Pump stream failure', { error })
    })

    completion
      .then(() => {
        completionFinished = true
        finalizeResponse()
      })
      .catch((error) => {
        if (responseEnded) return
        logger.error('Streaming message error', { agentId, sessionId, error: sanitizeDiagnostic(error) })
        try {
          writeSse(res, `data: ${JSON.stringify(errorEvent(error))}\n\n`)
        } catch (writeError) {
          logger.error('Error writing completion error to SSE stream', { error: writeError })
        }
        responseEnded = true
        cleanup()
        endResponse(res)
      })
    // Clear timeout when response ends
    res.on('close', cleanup)
    res.on('finish', cleanup)
  } catch (error: any) {
    streamController?.dispose()
    const taskLimit = getAgentTaskLimitDetails(error)
    if (taskLimit) {
      recordMainDiagnostic(diagnosticId, 'preparation', 'blocked', {
        phase: 'local-task-admission',
        ...taskLimit
      })
    }
    if (!sessionVerified) {
      recordMainDiagnostic(diagnosticId, 'preparation', 'failed', {
        phase: 'local-api-session-validation',
        error
      })
    }
    if (taskLimit) {
      logger.info('Assistant task rejected by shared capacity', {
        agentId: req.params.agentId,
        sessionId: req.params.sessionId,
        ...taskLimit
      })
    } else {
      logger.error('Error in streaming message handler', {
        error: sanitizeDiagnostic(error),
        agentId: req.params.agentId,
        sessionId: req.params.sessionId
      })
    }

    // Send error as SSE if possible
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
    }

    try {
      const errorResponse = errorEvent(
        error,
        taskLimit ? 'task_limit' : error?.status ? 'not_found' : 'internal_error',
        error?.status ? error.code : 'stream_creation_failed'
      )

      writeSse(res, `data: ${JSON.stringify(errorResponse)}\n\n`)
    } catch (writeError) {
      logger.error('Error writing initial error to SSE stream', { error: writeError })
    }

    endResponse(res)
  }
}

export const deleteMessage = async (req: Request, res: Response): Promise<Response> => {
  try {
    const { agentId, sessionId, messageId: messageIdParam } = req.params
    const messageId = Number(messageIdParam)

    await verifyAgentAndSession(agentId, sessionId)
    if (agentId === DEFAULT_OPENCODE_AGENT_ID) {
      return res.status(409).json({
        error: {
          code: 'native_history_required',
          type: 'conflict',
          message: 'Use native-history to delete new assistant messages; display-only deletion is not allowed'
        }
      })
    }

    const deleted = await sessionMessageService.deleteSessionMessage(sessionId, messageId)

    if (!deleted) {
      logger.warn('Session message not found', { agentId, sessionId, messageId })
      return res.status(404).json({
        error: {
          message: 'Message not found for this session',
          type: 'not_found',
          code: 'session_message_not_found'
        }
      })
    }

    logger.info('Session message deleted', { agentId, sessionId, messageId })
    return res.status(204).send()
  } catch (error: any) {
    if (error?.status === 404) {
      logger.warn('Delete message failed - missing resource', {
        agentId: req.params.agentId,
        sessionId: req.params.sessionId,
        messageId: req.params.messageId,
        error
      })
      return res.status(404).json({
        error: {
          message: error.message,
          type: 'not_found',
          code: error.code ?? 'session_message_not_found'
        }
      })
    }

    logger.error('Error deleting session message', {
      error,
      agentId: req.params.agentId,
      sessionId: req.params.sessionId,
      messageId: Number(req.params.messageId)
    })
    return res.status(500).json({
      error: {
        message: 'Failed to delete session message',
        type: 'internal_error',
        code: 'session_message_delete_failed'
      }
    })
  }
}
