import { DEFAULT_SESSION_PAGE_SIZE } from '@renderer/api/agent'
import { useAgentWorkspace } from '@renderer/context/AgentWorkspaceProvider'
import { DbService } from '@renderer/services/db/DbService'
import store, { useAppDispatch } from '@renderer/store'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import { setActiveAgentId, setActiveSessionIdAction } from '@renderer/store/runtime'
import type { GetAgentResponse } from '@renderer/types'
import { consumeAgentEntrySelection } from '@renderer/utils/agentEntrySelection'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { getAgentSessionDraft } from '@renderer/utils/agentSessionDraft'
import { isUnnamedAgentSessionName } from '@renderer/utils/agentSessionTitle'
import { hasUnsentConversationDraft } from '@renderer/utils/conversationDraft'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAgentClient } from './useAgentClient'

const dbService = DbService.getInstance()

export function useRestoreAgentSession(agents: GetAgentResponse[] | undefined, enabled: boolean) {
  const workspace = useAgentWorkspace()
  const client = useAgentClient()
  const dispatch = useAppDispatch()
  const { t } = useTranslation()
  const [restored, setRestored] = useState(false)

  useEffect(() => {
    if (restored || !enabled || !agents?.length) return
    let cancelled = false

    const restore = async () => {
      const chat = store.getState().runtime.chat
      const agentId = chat.activeAgentId
      const sessionId = agentId ? chat.activeSessionIdMap[agentId] : null
      const hasSelection = agentId && sessionId && agents.some((agent) => agent.id === agentId)

      if (
        hasSelection &&
        (consumeAgentEntrySelection(workspace, { agentId, sessionId }) ||
          workspace === 'opencode' ||
          hasUnsentConversationDraft(getAgentSessionDraft(agentId, sessionId)))
      ) {
        // Returning to the assistant keeps the conversation the user was reading,
        // including an unnamed session containing only an unsent draft.
        setRestored(true)
        return
      }

      const selectionChanged = () => {
        const latest = store.getState().runtime.chat
        return (
          cancelled ||
          latest.activeAgentId !== agentId ||
          (agentId ? latest.activeSessionIdMap[agentId] : null) !== sessionId
        )
      }
      const response = await client.listAllSessions({
        archived: 'exclude',
        limit: DEFAULT_SESSION_PAGE_SIZE,
        offset: 0
      })

      for (const session of response.data) {
        if (selectionChanged()) break
        const topicId = buildAgentSessionTopicId(session.id)
        const state = store.getState()
        let isRestorable =
          !isUnnamedAgentSessionName(session.name, t('common.unnamed')) ||
          hasUnsentConversationDraft(getAgentSessionDraft(session.agent_id, session.id)) ||
          Boolean(state.messages.loadingByTopic[topicId]) ||
          selectMessagesForTopic(state, topicId).length > 0

        if (!isRestorable) {
          const persisted = await dbService.fetchMessages(topicId, true)
          isRestorable = persisted.messages.length > 0
        }

        if (selectionChanged()) break
        if (!isRestorable) continue
        dispatch(setActiveAgentId(session.agent_id))
        dispatch(setActiveSessionIdAction({ agentId: session.agent_id, sessionId: session.id }))
        break
      }

      if (!cancelled) setRestored(true)
    }

    void restore().catch(() => {
      if (!cancelled) setRestored(true)
    })
    return () => {
      cancelled = true
    }
  }, [agents, client, dispatch, enabled, restored, t, workspace])
}
