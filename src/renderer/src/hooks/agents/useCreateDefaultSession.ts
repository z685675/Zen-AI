import { loggerService } from '@logger'
import { useAgent } from '@renderer/hooks/agents/useAgent'
import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useSessions } from '@renderer/hooks/agents/useSessions'
import { useUpdateSession } from '@renderer/hooks/agents/useUpdateSession'
import { DbService } from '@renderer/services/db/DbService'
import { useAppDispatch } from '@renderer/store'
import { setActiveSessionIdAction } from '@renderer/store/runtime'
import type { CreateSessionForm } from '@renderer/types'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { isUnnamedAgentSessionName } from '@renderer/utils/agentSessionTitle'
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
  const client = useAgentClient()
  const { sessions, createSession } = useSessions(agentId)
  const { updateSession } = useUpdateSession(agentId)
  const dispatch = useAppDispatch()
  const { t } = useTranslation()
  const [creatingSession, setCreatingSession] = useState(false)
  const canCreateSession = canCreateAgentSession(agentId)

  const resolveExistingEmptySession = useCallback(
    async (defaultModel: string) => {
      if (!agentId || sessions.length === 0) {
        return null
      }

      const unnamedSessionName = t('common.unnamed')
      const unnamedCandidates = sessions.filter((session) =>
        isUnnamedAgentSessionName(session.name, unnamedSessionName)
      )

      for (const emptyCandidate of unnamedCandidates) {
        let candidate = emptyCandidate
        const topicId = buildAgentSessionTopicId(candidate.id)
        const { messages } = await dbService.fetchMessages(topicId, true)
        const hasMessages = messages.length > 0
        if (hasMessages) {
          continue
        }

        if (candidate.model !== defaultModel) {
          const alignedSession = await updateSession(
            { id: candidate.id, model: defaultModel },
            { showSuccessToast: false }
          )
          if (!alignedSession) {
            continue
          }
          candidate = alignedSession
        }

        dispatch(setActiveSessionIdAction({ agentId, sessionId: candidate.id }))
        return candidate
      }

      return null
    },
    [agentId, dispatch, sessions, t, updateSession]
  )

  const createDefaultSession = useCallback(async () => {
    if (!agentId || !agent || creatingSession || !canCreateSession) {
      return null
    }

    setCreatingSession(true)
    try {
      let sessionDefaults = agent
      try {
        sessionDefaults = await client.getAgent(agentId)
      } catch (error) {
        logger.warn('Failed to refresh agent defaults before creating a session; using cached defaults', error as Error)
      }

      const existingEmptySession = await resolveExistingEmptySession(sessionDefaults.model)
      if (existingEmptySession) {
        return existingEmptySession
      }

      const session = {
        ...sessionDefaults,
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
  }, [
    agentId,
    agent,
    canCreateSession,
    client,
    createSession,
    creatingSession,
    dispatch,
    resolveExistingEmptySession,
    t
  ])

  return {
    createDefaultSession,
    creatingSession,
    canCreateSession
  }
}
