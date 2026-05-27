import { loggerService } from '@logger'
import { useAgent } from '@renderer/hooks/agents/useAgent'
import { useSessions } from '@renderer/hooks/agents/useSessions'
import { DbService } from '@renderer/services/db/DbService'
import { useAppDispatch } from '@renderer/store'
import { setActiveSessionIdAction } from '@renderer/store/runtime'
import type { CreateSessionForm } from '@renderer/types'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { canCreateAgentSession } from '@shared/config/agents'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('useCreateDefaultSession')
const dbService = DbService.getInstance()

/**
 * Returns a stable callback that creates a default agent session and updates UI state.
 */
export const useCreateDefaultSession = (agentId: string | null) => {
  const { agent } = useAgent(agentId)
  const { sessions, createSession } = useSessions(agentId)
  const dispatch = useAppDispatch()
  const { t } = useTranslation()
  const [creatingSession, setCreatingSession] = useState(false)
  const canCreateSession = canCreateAgentSession(agentId)

  const resolveExistingEmptySession = useCallback(async () => {
    if (!agentId || sessions.length === 0) {
      return null
    }

    const unnamedSessionName = t('common.unnamed')
    const unnamedCandidates = sessions.filter((session) => session.name === unnamedSessionName)

    for (const candidate of unnamedCandidates) {
      const topicId = buildAgentSessionTopicId(candidate.id)
      const { messages } = await dbService.fetchMessages(topicId, true)
      const hasMessages = messages.length > 0
      if (hasMessages) {
        continue
      }

      dispatch(setActiveSessionIdAction({ agentId, sessionId: candidate.id }))
      return candidate
    }

    return null
  }, [agentId, dispatch, sessions, t])

  const createDefaultSession = useCallback(async () => {
    if (!agentId || !agent || creatingSession || !canCreateSession) {
      return null
    }

    setCreatingSession(true)
    try {
      const existingEmptySession = await resolveExistingEmptySession()
      if (existingEmptySession) {
        return existingEmptySession
      }

      const session = {
        ...agent,
        id: undefined,
        name: t('common.unnamed')
      } satisfies CreateSessionForm

      const created = await createSession(session)

      if (created) {
        dispatch(setActiveSessionIdAction({ agentId, sessionId: created.id }))
      }

      return created
    } catch (error) {
      logger.error('Error creating default session:', error as Error)
      return null
    } finally {
      setCreatingSession(false)
    }
  }, [agentId, agent, canCreateSession, createSession, creatingSession, dispatch, resolveExistingEmptySession, t])

  return {
    createDefaultSession,
    creatingSession,
    canCreateSession
  }
}
