import { loggerService } from '@logger'
import { findAgentModelId, isStandardAgentModelIdentifier } from '@renderer/config/agentModelPolicy'
import { CURRENT_DEFAULT_MODEL_ID } from '@renderer/config/defaultModelPolicy'
import { useAgent } from '@renderer/hooks/agents/useAgent'
import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useSessions } from '@renderer/hooks/agents/useSessions'
import { useUpdateSession } from '@renderer/hooks/agents/useUpdateSession'
import { CacheService } from '@renderer/services/CacheService'
import { DbService } from '@renderer/services/db/DbService'
import { useAppDispatch } from '@renderer/store'
import { setActiveSessionIdAction } from '@renderer/store/runtime'
import type { AgentConfiguration, CreateSessionForm } from '@renderer/types'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { isUnnamedAgentSessionName } from '@renderer/utils/agentSessionTitle'
import { AGENT_DEFAULT_REASONING_EFFORT, getAgentSessionReasoningEffortCacheKey } from '@renderer/utils/reasoningEffort'
import { canCreateAgentSession } from '@shared/config/agents'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('useCreateDefaultSession')
const dbService = DbService.getInstance()
const SESSION_PREFERENCE_CACHE_TTL = 24 * 60 * 60 * 1000
const sessionCreationLocks = new Set<string>()

const withDefaultReasoningEffort = (configuration?: AgentConfiguration): AgentConfiguration => ({
  ...configuration,
  permission_mode: configuration?.permission_mode ?? 'default',
  max_turns: configuration?.max_turns ?? 100,
  env_vars: configuration?.env_vars ?? {},
  reasoning_effort: AGENT_DEFAULT_REASONING_EFFORT
})

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

  const resolveCurrentDefaultModel = useCallback(
    async (fallbackModel: string) => {
      if (isStandardAgentModelIdentifier(fallbackModel)) {
        return fallbackModel
      }

      try {
        const { data } = await client.getModels({ limit: 1000 })
        return findAgentModelId(data, CURRENT_DEFAULT_MODEL_ID) ?? fallbackModel
      } catch (error) {
        logger.warn('Failed to resolve the current default Agent model; using the existing default', error as Error)
        return fallbackModel
      }
    },
    [client]
  )

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

        const needsDefaultModel = candidate.model !== defaultModel
        const needsDefaultReasoningEffort = candidate.configuration?.reasoning_effort !== AGENT_DEFAULT_REASONING_EFFORT
        if (needsDefaultModel || needsDefaultReasoningEffort) {
          const alignedSession = await updateSession(
            {
              id: candidate.id,
              model: defaultModel,
              configuration: withDefaultReasoningEffort(candidate.configuration)
            },
            { showSuccessToast: false }
          )
          if (!alignedSession) {
            continue
          }
          candidate = alignedSession
        }

        CacheService.set(
          getAgentSessionReasoningEffortCacheKey(agentId, candidate.id),
          AGENT_DEFAULT_REASONING_EFFORT,
          SESSION_PREFERENCE_CACHE_TTL
        )
        dispatch(setActiveSessionIdAction({ agentId, sessionId: candidate.id }))
        return candidate
      }

      return null
    },
    [agentId, dispatch, sessions, t, updateSession]
  )

  const createDefaultSession = useCallback(async () => {
    if (!agentId || !agent || creatingSession || !canCreateSession || sessionCreationLocks.has(agentId)) {
      return null
    }

    sessionCreationLocks.add(agentId)
    setCreatingSession(true)
    try {
      let sessionDefaults = agent
      try {
        sessionDefaults = await client.getAgent(agentId)
      } catch (error) {
        logger.warn('Failed to refresh agent defaults before creating a session; using cached defaults', error as Error)
      }

      sessionDefaults = {
        ...sessionDefaults,
        model: await resolveCurrentDefaultModel(sessionDefaults.model)
      }

      const existingEmptySession = await resolveExistingEmptySession(sessionDefaults.model)
      if (existingEmptySession) {
        return existingEmptySession
      }

      const session = {
        ...sessionDefaults,
        configuration: withDefaultReasoningEffort(sessionDefaults.configuration),
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
      sessionCreationLocks.delete(agentId)
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
    resolveCurrentDefaultModel,
    resolveExistingEmptySession,
    t
  ])

  return {
    createDefaultSession,
    creatingSession,
    canCreateSession
  }
}
