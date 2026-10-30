import { useAppSelector } from '@renderer/store'
import type { Message } from '@renderer/types/newMessage'
import { extractAgentSessionIdFromTopicId, isAgentSessionTopicId } from '@renderer/utils/agentSession'
import type { AutomationOverview } from '@shared/agents/automation'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import useSWR from 'swr'

/** A queued mirror is not delivery: display only the current binding's fully acknowledged turn. */
export default function AgentMessageSyncStatus({ message, processing }: { message: Message; processing: boolean }) {
  const { t } = useTranslation()
  const latest = useAppSelector((state) => {
    const ids = state.messages.messageIdsByTopic[message.topicId] ?? []
    for (let index = ids.length - 1; index >= 0; index--) {
      const candidate = state.messages.entities[ids[index]]
      if (candidate?.role === 'assistant') return candidate.id === message.id
    }
    return false
  })
  const nativeTurn = message.providerMetadata?.zenAutomation as { persistenceId?: string } | undefined
  const runId = nativeTurn?.persistenceId || message.providerMetadata?.agentSessionSync?.runId
  const eligible =
    latest &&
    !processing &&
    message.status === 'success' &&
    message.role === 'assistant' &&
    message.assistantId === DEFAULT_OPENCODE_AGENT_ID &&
    isAgentSessionTopicId(message.topicId) &&
    Boolean(runId)
  const sessionId = extractAgentSessionIdFromTopicId(message.topicId)
  const isSynced = (overview?: AutomationOverview) =>
    Boolean(
      overview?.connection.enabled &&
        overview.connection.sessionId === sessionId &&
        overview.syncedRuns?.some((run) => run.id === runId && run.sessionId === sessionId)
    )
  const { data, error } = useSWR(
    eligible ? 'assistant-automation-status' : null,
    async () => {
      const response = await window.api.assistantAutomation({ action: 'status' })
      // Do not retain an old success badge when the authoritative status cannot be read.
      return response.ok ? response.data : null
    },
    {
      refreshInterval: (overview) => (isSynced(overview ?? undefined) ? 10_000 : 2000),
      dedupingInterval: 1000,
      shouldRetryOnError: false
    }
  )

  if (!eligible || error || !isSynced(data ?? undefined)) return null
  return <SyncStatus role="status">{t('automation.syncComplete')}</SyncStatus>
}

const SyncStatus = styled.div`
  align-self: flex-end;
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-3);
`
