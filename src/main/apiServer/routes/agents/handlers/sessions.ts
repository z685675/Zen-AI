import { loggerService } from '@logger'
import { AgentModelValidationError, sessionService } from '@main/services/agents'
import { broadcastSessionChanged } from '@main/services/agents/services/channels/sessionStreamIpc'
import { legacyContinuationService } from '@main/services/agents/services/LegacyContinuationService'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import type { ListAgentSessionsResponse, SearchAgentSessionsResponse, UpdateSessionResponse } from '@types'
import { type ReplaceSessionRequest } from '@types'
import type { Request, Response } from 'express'

import type { ValidationRequest } from '../validators/zodValidator'

const logger = loggerService.withContext('ApiServerSessionsHandlers')

export const inspectSessionSkills = async (req: Request, res: Response): Promise<Response> => {
  const { agentId, sessionId } = req.params
  if (agentId !== DEFAULT_OPENCODE_AGENT_ID) return res.sendStatus(404)
  try {
    const session = await sessionService.getSession(agentId, sessionId)
    if (!session) return res.sendStatus(404)
    const { getSessionSkillInventory } = await import('@main/services/agents/services/opencode/skillInventory')
    return res.json(await getSessionSkillInventory(session))
  } catch {
    return res.status(503).json({ error: { code: 'inventory_unavailable', message: 'Inventory unavailable' } })
  }
}

export const continueInNewAssistant = async (req: Request, res: Response): Promise<Response> => {
  const controller = new AbortController()
  const onClose = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.on('close', onClose)
  try {
    const result = await legacyContinuationService.continueSession(
      req.params.agentId,
      req.params.sessionId,
      AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    )
    broadcastSessionChanged(DEFAULT_OPENCODE_AGENT_ID, result.session.id, false, 'created')
    return res.json(result)
  } catch (error) {
    const code = (error as { code?: string }).code
    const known = typeof code === 'string' && code.startsWith('continuation_') ? code : 'continuation_prepare_failed'
    logger.warn('Legacy continuation failed; source retained', { code: known, error })
    return res
      .status(
        known === 'continuation_source_missing'
          ? 404
          : known === 'continuation_busy' || known === 'continuation_source_changed'
            ? 409
            : 422
      )
      .json({ error: { code: known, message: known, type: 'continuation_error' } })
  } finally {
    res.off('close', onClose)
  }
}

export const changeNativeHistory = async (req: Request, res: Response): Promise<Response> => {
  const { agentId, sessionId } = req.params
  const { action, messageId } = req.body ?? {}
  if (agentId !== DEFAULT_OPENCODE_AGENT_ID || !(await sessionService.sessionExists(agentId, sessionId)))
    return res.status(404).json({ error: { code: 'session_not_found', message: 'New assistant session not found' } })
  if (
    !['retry', 'delete', 'fork'].includes(action) ||
    typeof messageId !== 'string' ||
    !messageId ||
    messageId.length > 256
  )
    return res.status(400).json({ error: { code: 'invalid_history_operation', message: 'Invalid history operation' } })
  try {
    const session = await sessionService.changeOpenCodeHistory(agentId, sessionId, messageId, action)
    broadcastSessionChanged(agentId, session.id, false, action === 'fork' ? 'created' : 'completed')
    return res.json(session)
  } catch (error) {
    logger.warn('Native history operation failed; original history retained', { action, error })
    return res.status(409).json({
      error: {
        code: 'native_history_change_failed',
        message: 'History was not changed; stop any active task and retry'
      }
    })
  }
}

export const resetNativeMemory = async (req: Request, res: Response): Promise<Response> => {
  const { agentId, sessionId } = req.params
  if (agentId !== DEFAULT_OPENCODE_AGENT_ID || !(await sessionService.sessionExists(agentId, sessionId))) {
    return res
      .status(404)
      .json({ error: { message: 'New assistant session not found', type: 'not_found', code: 'session_not_found' } })
  }
  try {
    await sessionService.resetOpenCodeMemory(agentId, sessionId)
    return res.status(204).send()
  } catch {
    return res.status(409).json({
      error: {
        message: 'Stop the task before clearing native memory, then retry',
        type: 'conflict',
        code: 'native_memory_reset_failed'
      }
    })
  }
}

const modelValidationErrorBody = (error: AgentModelValidationError) => ({
  error: {
    message: `Invalid ${error.context.field}: ${error.detail.message}`,
    type: 'invalid_request_error',
    code: error.detail.code
  }
})

export const createSession = async (req: Request, res: Response): Promise<Response> => {
  const { agentId } = req.params
  try {
    const sessionData = req.body

    logger.debug('Creating new session', { agentId })
    logger.debug('Session payload', { sessionData })

    const session = await sessionService.createSession(agentId, sessionData)
    if (!session) {
      throw new Error('Session service returned no session')
    }
    broadcastSessionChanged(agentId, session.id, false, 'created')

    logger.info('Session created', { agentId, sessionId: session?.id })
    return res.status(201).json(session)
  } catch (error: any) {
    if (error instanceof AgentModelValidationError) {
      logger.warn('Session model validation error during create', {
        agentId,
        agentType: error.context.agentType,
        field: error.context.field,
        model: error.context.model,
        detail: error.detail
      })
      return res.status(400).json(modelValidationErrorBody(error))
    }

    logger.error('Error creating session', { error, agentId })
    return res.status(500).json({
      error: {
        message: `Failed to create session: ${error.message}`,
        type: 'internal_error',
        code: 'session_creation_failed'
      }
    })
  }
}

export const listSessions = async (req: Request, res: Response): Promise<Response> => {
  const { agentId } = req.params
  try {
    const validationReq = req as ValidationRequest
    const limit = validationReq.validatedQuery?.limit ?? (req.query.limit ? parseInt(req.query.limit as string) : 20)
    const offset = validationReq.validatedQuery?.offset ?? (req.query.offset ? parseInt(req.query.offset as string) : 0)
    const archived = validationReq.validatedQuery?.archived ?? 'exclude'
    const status = req.query.status as any

    logger.debug('Listing agent sessions', { agentId, limit, offset, status, archived })

    const result = await sessionService.listSessions(agentId, { limit, offset, archived })

    logger.info('Agent sessions listed', {
      agentId,
      returned: result.sessions.length,
      total: result.total,
      limit,
      offset
    })
    return res.json({
      data: result.sessions,
      total: result.total,
      limit,
      offset
    })
  } catch (error: any) {
    logger.error('Error listing sessions', { error, agentId })
    return res.status(500).json({
      error: {
        message: 'Failed to list sessions',
        type: 'internal_error',
        code: 'session_list_failed'
      }
    })
  }
}

export const getSession = async (req: Request, res: Response): Promise<Response> => {
  try {
    const { agentId, sessionId } = req.params
    logger.debug('Getting session', { agentId, sessionId })

    const session = await sessionService.getSession(agentId, sessionId)

    if (!session) {
      logger.warn('Session not found', { agentId, sessionId })
      return res.status(404).json({
        error: {
          message: 'Session not found',
          type: 'not_found',
          code: 'session_not_found'
        }
      })
    }

    // // Verify session belongs to the agent
    //   logger.warn(`Session ${sessionId} does not belong to agent ${agentId}`)
    //   return res.status(404).json({
    //     error: {
    //       message: 'Session not found for this agent',
    //       type: 'not_found',
    //       code: 'session_not_found'
    //     }
    //   })
    // }
    return res.json(session)
  } catch (error: any) {
    logger.error('Error getting session', { error, agentId: req.params.agentId, sessionId: req.params.sessionId })
    return res.status(500).json({
      error: {
        message: 'Failed to get session',
        type: 'internal_error',
        code: 'session_get_failed'
      }
    })
  }
}

export const updateSession = async (req: Request, res: Response): Promise<Response> => {
  const { agentId, sessionId } = req.params
  try {
    logger.debug('Updating session', { agentId, sessionId })
    logger.debug('Replace payload', { body: req.body })

    // First check if session exists and belongs to agent
    const existingSession = await sessionService.getSession(agentId, sessionId)
    if (!existingSession || existingSession.agent_id !== agentId) {
      logger.warn('Session not found for update', { agentId, sessionId })
      return res.status(404).json({
        error: {
          message: 'Session not found for this agent',
          type: 'not_found',
          code: 'session_not_found'
        }
      })
    }

    const { validatedBody } = req as ValidationRequest
    const replacePayload = (validatedBody ?? {}) as ReplaceSessionRequest

    const session = await sessionService.updateSession(agentId, sessionId, replacePayload)

    if (!session) {
      logger.warn('Session missing during update', { agentId, sessionId })
      return res.status(404).json({
        error: {
          message: 'Session not found',
          type: 'not_found',
          code: 'session_not_found'
        }
      })
    }

    logger.info('Session updated', { agentId, sessionId })
    return res.json(session satisfies UpdateSessionResponse)
  } catch (error: any) {
    if (error instanceof AgentModelValidationError) {
      logger.warn('Session model validation error during update', {
        agentId,
        sessionId,
        agentType: error.context.agentType,
        field: error.context.field,
        model: error.context.model,
        detail: error.detail
      })
      return res.status(400).json(modelValidationErrorBody(error))
    }

    logger.error('Error updating session', { error, agentId, sessionId })
    return res.status(500).json({
      error: {
        message: `Failed to update session: ${error.message}`,
        type: 'internal_error',
        code: 'session_update_failed'
      }
    })
  }
}

export const patchSession = async (req: Request, res: Response): Promise<Response> => {
  const { agentId, sessionId } = req.params
  try {
    logger.debug('Patching session', { agentId, sessionId })
    logger.debug('Patch payload', { body: req.body })

    // First check if session exists and belongs to agent
    const existingSession = await sessionService.getSession(agentId, sessionId)
    if (!existingSession || existingSession.agent_id !== agentId) {
      logger.warn('Session not found for patch', { agentId, sessionId })
      return res.status(404).json({
        error: {
          message: 'Session not found for this agent',
          type: 'not_found',
          code: 'session_not_found'
        }
      })
    }

    const updateSession = { ...existingSession, ...req.body }
    const session = await sessionService.updateSession(agentId, sessionId, updateSession)

    if (!session) {
      logger.warn('Session missing while patching', { agentId, sessionId })
      return res.status(404).json({
        error: {
          message: 'Session not found',
          type: 'not_found',
          code: 'session_not_found'
        }
      })
    }

    logger.info('Session patched', { agentId, sessionId })
    return res.json(session)
  } catch (error: any) {
    if (error instanceof AgentModelValidationError) {
      logger.warn('Session model validation error during patch', {
        agentId,
        sessionId,
        agentType: error.context.agentType,
        field: error.context.field,
        model: error.context.model,
        detail: error.detail
      })
      return res.status(400).json(modelValidationErrorBody(error))
    }

    logger.error('Error patching session', { error, agentId, sessionId })
    return res.status(500).json({
      error: {
        message: `Failed to patch session, ${error.message}`,
        type: 'internal_error',
        code: 'session_patch_failed'
      }
    })
  }
}

export const deleteSession = async (req: Request, res: Response): Promise<Response> => {
  try {
    const { agentId, sessionId } = req.params
    logger.debug('Deleting session', { agentId, sessionId })

    // First check if session exists and belongs to agent
    const existingSession = await sessionService.getSession(agentId, sessionId)
    if (!existingSession || existingSession.agent_id !== agentId) {
      logger.warn('Session not found for deletion', { agentId, sessionId })
      return res.status(404).json({
        error: {
          message: 'Session not found for this agent',
          type: 'not_found',
          code: 'session_not_found'
        }
      })
    }

    const deleted = await sessionService.deleteSession(agentId, sessionId)

    if (!deleted) {
      logger.warn('Session missing during delete', { agentId, sessionId })
      return res.status(404).json({
        error: {
          message: 'Session not found',
          type: 'not_found',
          code: 'session_not_found'
        }
      })
    }

    logger.info('Session deleted', { agentId, sessionId })

    return res.status(204).send()
  } catch (error: any) {
    logger.error('Error deleting session', { error, agentId: req.params.agentId, sessionId: req.params.sessionId })
    return res.status(500).json({
      error: {
        message: 'Failed to delete session',
        type: 'internal_error',
        code: 'session_delete_failed'
      }
    })
  }
}

export const reorderSessions = async (req: Request, res: Response): Promise<Response> => {
  const { agentId } = req.params
  try {
    const { ordered_ids } = req.body

    if (
      !Array.isArray(ordered_ids) ||
      ordered_ids.length === 0 ||
      !ordered_ids.every((id: unknown) => typeof id === 'string' && id.length > 0)
    ) {
      return res.status(400).json({
        error: {
          message: 'ordered_ids must be a non-empty array of session IDs',
          type: 'invalid_request_error',
          code: 'invalid_ordered_ids'
        }
      })
    }

    logger.debug('Reordering sessions', { agentId, count: ordered_ids.length })
    await sessionService.reorderSessions(agentId, ordered_ids)

    logger.info('Sessions reordered', { agentId, count: ordered_ids.length })
    return res.json({ success: true })
  } catch (error: any) {
    logger.error('Error reordering sessions', { error, agentId })
    return res.status(500).json({
      error: {
        message: 'Failed to reorder sessions',
        type: 'internal_error',
        code: 'session_reorder_failed'
      }
    })
  }
}

// Convenience endpoints for sessions without agent context
export const listAllSessions = async (req: Request, res: Response): Promise<Response> => {
  try {
    const validationReq = req as ValidationRequest
    const limit = validationReq.validatedQuery?.limit ?? (req.query.limit ? parseInt(req.query.limit as string) : 20)
    const offset = validationReq.validatedQuery?.offset ?? (req.query.offset ? parseInt(req.query.offset as string) : 0)
    const archived = validationReq.validatedQuery?.archived ?? 'exclude'
    const status = req.query.status as any

    logger.debug('Listing all sessions', { limit, offset, status, archived })

    const result = await sessionService.listSessions(undefined, {
      workspace: res.locals.agentWorkspace ?? 'legacy',
      limit,
      offset,
      sortBy: 'updated_at',
      orderBy: 'desc',
      archived
    })

    logger.info('Sessions listed', {
      returned: result.sessions.length,
      total: result.total,
      limit,
      offset
    })
    return res.json({
      data: result.sessions,
      total: result.total,
      limit,
      offset
    } satisfies ListAgentSessionsResponse)
  } catch (error: any) {
    logger.error('Error listing all sessions', { error })
    return res.status(500).json({
      error: {
        message: 'Failed to list sessions',
        type: 'internal_error',
        code: 'session_list_failed'
      }
    })
  }
}

export const searchAllSessions = async (req: Request, res: Response): Promise<Response> => {
  try {
    const validationReq = req as ValidationRequest
    const query = validationReq.validatedQuery?.query ?? String(req.query.query ?? '').trim()
    const limit = validationReq.validatedQuery?.limit ?? 20
    const offset = validationReq.validatedQuery?.offset ?? 0
    const archived = validationReq.validatedQuery?.archived ?? 'include'

    logger.debug('Searching all sessions', { query, limit, offset, archived })

    const result = await sessionService.searchSessions(query, {
      workspace: res.locals.agentWorkspace ?? 'legacy',
      limit,
      offset,
      archived
    })

    logger.info('Session search completed', {
      query,
      returned: result.results.length,
      total: result.total,
      limit,
      offset,
      archived
    })

    return res.json({
      data: result.results,
      total: result.total,
      limit,
      offset
    } satisfies SearchAgentSessionsResponse)
  } catch (error: any) {
    logger.error('Error searching sessions', { error })
    return res.status(500).json({
      error: {
        message: 'Failed to search sessions',
        type: 'internal_error',
        code: 'session_search_failed'
      }
    })
  }
}
