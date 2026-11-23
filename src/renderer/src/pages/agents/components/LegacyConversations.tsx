import { QuickPanelProvider } from '@renderer/components/QuickPanel'
import { useAllSessions } from '@renderer/hooks/agents/useAllSessions'
import { useSession } from '@renderer/hooks/agents/useSession'
import { useSettings } from '@renderer/hooks/useSettings'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import { cn } from '@renderer/utils'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { getLegacyConversationPath, type LegacyConversation } from '@renderer/utils/legacyConversations'
import { Button, Spin } from 'antd'
import { FolderOpen } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import ChatNavigation from '../../home/Messages/ChatNavigation'
import AgentSessionMessages from './AgentSessionMessages'
import AssistantTransitionBanner from './AssistantTransitionBanner'
import SessionItem from './SessionItem'

export function LegacyConversationList({ selection }: { selection?: LegacyConversation }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { sessions, error, isLoading, hasMore, isLoadingMore, loadMore, reload } = useAllSessions({
    archived: 'include'
  })

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
      {sessions.map((session) => (
        <SessionItem
          key={session.id}
          agentId={session.agent_id}
          session={session}
          isActive={selection?.sessionId === session.id && selection.agentId === session.agent_id}
          onPress={() => navigate(getLegacyConversationPath({ agentId: session.agent_id, sessionId: session.id }))}
          readOnly
        />
      ))}
      <div className="flex flex-col items-center gap-2 py-2 text-(--color-text-secondary) text-xs">
        {error ? (
          <>
            <span role="alert">{t('agent.session.get.error.failed')}</span>
            <Button size="small" onClick={() => void reload()}>
              {t('common.retry')}
            </Button>
          </>
        ) : isLoading ? (
          <Spin size="small" />
        ) : hasMore ? (
          <Button size="small" loading={isLoadingMore} onClick={loadMore}>
            {t('assistant_transition.load_more_history')}
          </Button>
        ) : sessions.length === 0 ? (
          t('history.no_history')
        ) : null}
      </div>
    </div>
  )
}

export function LegacyConversationView({ agentId, sessionId }: LegacyConversation) {
  const { t } = useTranslation()
  const { session, error, isLoading } = useSession(agentId, sessionId)
  const { messageNavigation, messageStyle } = useSettings()
  const dispatch = useAppDispatch()
  const topicId = buildAgentSessionTopicId(sessionId)
  const loaded = useAppSelector((state) => state.messages.loadedByTopic[topicId])
  const hasMessages = useAppSelector((state) => Boolean(state.messages.messageIdsByTopic[topicId]?.length))
  const [loadFinished, setLoadFinished] = useState(false)
  const loadHistory = useCallback(async () => {
    setLoadFinished(false)
    await dispatch(loadTopicMessagesThunk(topicId))
    setLoadFinished(true)
  }, [dispatch, topicId])

  useEffect(() => {
    if (session?.id === sessionId) void loadHistory()
  }, [loadHistory, session?.id, sessionId])

  if (error || (!isLoading && !session)) {
    return (
      <div role="alert" className="m-auto">
        {t('agent.session.get.error.failed')}
      </div>
    )
  }
  if (!session) return <Spin className="m-auto" />

  const workspace = session.accessible_paths?.[0]
  return (
    <section className={cn('relative flex min-w-0 flex-1 flex-col overflow-hidden', messageStyle)}>
      <div className="mx-4 my-2 flex shrink-0 items-center justify-between gap-2">
        <h2 className="m-0 truncate font-semibold text-sm" title={session.name}>
          {session.name || t('common.untitled_conversation')}
        </h2>
        {workspace && (
          <Button
            size="small"
            icon={<FolderOpen size={14} />}
            title={workspace}
            onClick={() => {
              void window.api.file
                .openPath(workspace)
                .catch(() => window.toast.error(t('files.error.open_path', { path: workspace })))
            }}>
            {t('agent.session.accessible_paths.label')}
          </Button>
        )}
      </div>
      <AssistantTransitionBanner agentId={agentId} session={session} legacyHistory running={!loaded || !hasMessages} />
      <QuickPanelProvider>
        {!loaded && !loadFinished ? (
          <Spin className="m-auto" />
        ) : !loaded ? (
          <div className="m-auto flex flex-col items-center gap-2">
            <span role="alert">{t('agent.session.get.error.failed')}</span>
            <Button size="small" onClick={() => void loadHistory()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : !hasMessages ? (
          <div className="m-auto text-(--color-text-secondary)">{t('history.no_history')}</div>
        ) : (
          <>
            <AgentSessionMessages key={sessionId} agentId={agentId} sessionId={sessionId} readOnly />
            {messageNavigation === 'buttons' && <ChatNavigation containerId="messages" />}
          </>
        )}
      </QuickPanelProvider>
    </section>
  )
}
