import { loggerService } from '@logger'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useAppDispatch } from '@renderer/store'
import { setActiveSessionIdAction } from '@renderer/store/runtime'
import { useCallback, useEffect, useRef } from 'react'

import { useAgentClient } from './useAgentClient'

const logger = loggerService.withContext('useAgentSessionInitializer')
const sessionInitializationRequests = new Map<string, Promise<string | null>>()

/**
 * Hook to automatically initialize and load the latest session for an agent
 * when the agent is activated. This ensures that when switching to an agent,
 * its most recent session is automatically selected.
 */
export const useAgentSessionInitializer = () => {
  const dispatch = useAppDispatch()
  const client = useAgentClient()
  const { chat } = useRuntime()
  const { activeAgentId, activeSessionIdMap } = chat

  // Use a ref to keep the callback stable across activeSessionIdMap changes
  const activeSessionIdMapRef = useRef(activeSessionIdMap)
  activeSessionIdMapRef.current = activeSessionIdMap

  /**
   * Initialize session for the given agent by loading its sessions
   * and setting the latest one as active
   */
  const initializeAgentSession = useCallback(
    async (agentId: string) => {
      if (!agentId) return

      try {
        if (activeSessionIdMapRef.current[agentId]) {
          return
        }

        let request = sessionInitializationRequests.get(agentId)
        if (!request) {
          request = client
            .listSessions(agentId)
            .then((response) => response.data[0]?.id ?? null)
            .finally(() => {
              sessionInitializationRequests.delete(agentId)
            })
          sessionInitializationRequests.set(agentId, request)
        }

        const latestSessionId = await request

        // Do not replace a session selected by the user while initialization was in flight.
        if (activeSessionIdMapRef.current[agentId]) {
          return
        }

        dispatch(setActiveSessionIdAction({ agentId, sessionId: latestSessionId }))
      } catch (error) {
        logger.error('Failed to initialize agent session:', error as Error)
      }
    },
    [client, dispatch]
  )

  /**
   * Auto-initialize when activeAgentId changes
   */
  useEffect(() => {
    if (activeAgentId && !activeSessionIdMapRef.current[activeAgentId]) {
      void initializeAgentSession(activeAgentId)
    }
  }, [activeAgentId, initializeAgentSession])

  return {
    initializeAgentSession
  }
}
