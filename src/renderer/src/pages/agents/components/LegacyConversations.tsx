import { loggerService } from '@logger'
import { type AgentApiClient, DEFAULT_SESSION_PAGE_SIZE } from '@renderer/api/agent'
import { QuickPanelProvider } from '@renderer/components/QuickPanel'
import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useAllSessions } from '@renderer/hooks/agents/useAllSessions'
import { useSession } from '@renderer/hooks/agents/useSession'
import { useSettings } from '@renderer/hooks/useSettings'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { AgentSessionEntity } from '@renderer/types'
import { cn } from '@renderer/utils'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { clearAgentSessionDraft } from '@renderer/utils/agentSessionDraft'
import {
  getLegacyConversationPath,
  LEGACY_CONVERSATIONS_PATH,
  type LegacyConversation
} from '@renderer/utils/legacyConversations'
import { isNewAssistantAgentId } from '@shared/config/agents'
import { Button, Spin } from 'antd'
import { ChevronDown, ChevronRight, Folder, FolderOpen, Trash2 } from 'lucide-react'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { useSWRConfig } from 'swr'

import ChatNavigation from '../../home/Messages/ChatNavigation'
import AgentSessionMessages from './AgentSessionMessages'
import AssistantTransitionBanner from './AssistantTransitionBanner'
import LegacyAssistantInputbar from './LegacyAssistantInputbar'
import SessionItem from './SessionItem'

const logger = loggerService.withContext('LegacyConversations')

async function listLegacyDeletionTargets(client: AgentApiClient) {
  // Read a complete set before deleting so removals cannot shift the next page.
  const targets = new Map<string, LegacyConversation>()
  let offset = 0
  for (;;) {
    const { data, total } = await client.listAllSessions({
      archived: 'include',
      limit: DEFAULT_SESSION_PAGE_SIZE,
      offset
    })
    for (const session of data) {
      if (isNewAssistantAgentId(session.agent_id)) throw new Error('Unexpected workspace in old conversations')
      targets.set(session.id, { agentId: session.agent_id, sessionId: session.id })
    }
    offset += data.length
    if (offset >= total) return targets.values()
    if (data.length === 0) throw new Error('Incomplete old conversation list')
  }
}

export function LegacyConversationFolder({
  expanded,
  selection,
  serverAvailable
}: {
  expanded: boolean
  selection?: LegacyConversation
  serverAvailable: boolean
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const activeLocationKey = useRef<string | null>(location.key)
  useEffect(() => {
    activeLocationKey.current = location.key
    return () => {
      activeLocationKey.current = null
    }
  }, [location.key])
  const client = useAgentClient()
  const { mutate } = useSWRConfig()
  const { sessions, total, error, isLoading, hasMore, isLoadingMore, loadMore, reload } = useAllSessions({
    archived: 'include',
    enabled: serverAvailable || expanded
  })
  const deletionPending = useRef(false)
  const [deleting, setDeleting] = useState(false)

  const afterDeletion = (path: string) => {
    if (activeLocationKey.current === location.key) navigate(path, { replace: true })
  }

  const confirmDeletion = (title: string, content: string, remove: () => Promise<void>) => {
    window.modal.confirm({
      title,
      content,
      centered: true,
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (deletionPending.current) return
        deletionPending.current = true
        setDeleting(true)
        try {
          await remove()
        } finally {
          deletionPending.current = false
          setDeleting(false)
        }
      }
    })
  }

  const removeSession = async ({ agentId, sessionId }: LegacyConversation) => {
    await client.deleteSession(agentId, sessionId)
    clearAgentSessionDraft(agentId, sessionId)
    await mutate(client.getSessionPaths(agentId).withId(sessionId), undefined, { revalidate: false })
  }

  const confirmSessionDeletion = (session: AgentSessionEntity) => {
    if (isNewAssistantAgentId(session.agent_id)) return
    confirmDeletion(t('agent.session.delete.title'), t('agent.session.delete.content'), async () => {
      const target = { agentId: session.agent_id, sessionId: session.id }
      try {
        await removeSession(target)
      } catch (error) {
        logger.warn('Failed to delete an old conversation', error as Error)
        window.toast.error(t('agent.session.delete.error.failed'))
        return
      }

      await reload()
      if (total === 1) {
        afterDeletion('/new-assistant')
      } else if (selection?.sessionId === target.sessionId && selection.agentId === target.agentId) {
        afterDeletion(LEGACY_CONVERSATIONS_PATH)
      }
    })
  }

  const confirmFolderDeletion = () => {
    confirmDeletion(
      t('assistant_transition.delete_legacy_folder'),
      t('assistant_transition.delete_legacy_folder_confirm'),
      async () => {
        let removedSelection = false
        let empty = false
        try {
          for (const target of await listLegacyDeletionTargets(client)) {
            try {
              await removeSession(target)
              if (selection?.sessionId === target.sessionId && selection.agentId === target.agentId) {
                removedSelection = true
              }
            } catch (error) {
              logger.warn('Failed to delete an old conversation', error as Error)
            }
          }
          const remaining = await client.listAllSessions({ archived: 'include', limit: 1, offset: 0 })
          empty = remaining.total === 0
        } catch (error) {
          logger.warn('Failed to delete the old conversation folder', error as Error)
        }

        await reload()
        if (empty) {
          afterDeletion('/new-assistant')
        } else {
          if (removedSelection) afterDeletion(LEGACY_CONVERSATIONS_PATH)
          window.toast.error(t('assistant_transition.delete_legacy_folder_failed'))
        }
      }
    )
  }

  if (!expanded && serverAvailable && !isLoading && !error && total === 0) return null

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => navigate(expanded ? '/new-assistant' : LEGACY_CONVERSATIONS_PATH)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-(--zen-radius-sm) border-0 bg-transparent px-2.5 py-2 font-medium text-(--zen-text-2) text-[12.5px] transition-colors hover:bg-(--zen-bg-hover) hover:text-(--zen-text-1)">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
          {t('assistant_transition.legacy_history')}
        </button>
        {total > 0 && (
          <LegacyDeleteButton
            label={t('assistant_transition.delete_legacy_folder')}
            disabled={deleting}
            onClick={confirmFolderDeletion}
          />
        )}
      </div>
      {expanded && (
        <div className="ml-4 border-(--zen-border) border-l pl-2">
          {sessions.map((session) => {
            const remove = () => confirmSessionDeletion(session)
            const title = session.name?.trim() || t('common.untitled_conversation')
            return (
              <div className="flex items-center gap-1" key={session.id}>
                <div className="min-w-0 flex-1">
                  <SessionItem
                    agentId={session.agent_id}
                    session={session}
                    isActive={selection?.sessionId === session.id && selection.agentId === session.agent_id}
                    onPress={() =>
                      navigate(getLegacyConversationPath({ agentId: session.agent_id, sessionId: session.id }))
                    }
                    onDelete={deleting ? undefined : remove}
                    readOnly
                  />
                </div>
                <LegacyDeleteButton
                  label={`${t('agent.session.delete.title')} · ${title}`}
                  disabled={deleting}
                  onClick={remove}
                />
              </div>
            )
          })}
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
      )}
    </div>
  )
}

function LegacyDeleteButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-(--zen-radius-sm) border-0 bg-transparent text-(--zen-text-3) transition-colors hover:bg-(--zen-bg-hover) hover:text-(--zen-danger) disabled:opacity-40">
      <Trash2 size={14} />
    </button>
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
  const [finishedTopicId, setFinishedTopicId] = useState<string | null>(null)
  const loadHistory = useCallback(async () => {
    setFinishedTopicId(null)
    await dispatch(loadTopicMessagesThunk(topicId))
    setFinishedTopicId(topicId)
  }, [dispatch, topicId])

  useEffect(() => {
    if (session?.id === sessionId) void loadHistory()
  }, [loadHistory, session?.id, sessionId])

  const loadFinished = finishedTopicId === topicId

  if (error || (!isLoading && !session)) {
    return (
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div role="alert" className="m-auto">
          {t('agent.session.get.error.failed')}
        </div>
        <LegacyAssistantInputbar />
      </section>
    )
  }
  if (!session) {
    return (
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spin />
        </div>
        <LegacyAssistantInputbar />
      </section>
    )
  }

  const workspace = session.accessible_paths?.[0]
  return (
    <section className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', messageStyle)}>
      <div className="mx-6 my-2.5 flex shrink-0 items-center justify-between gap-2">
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
        <div
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          style={{ '--zen-composer-inset': '140px' } as CSSProperties}>
          {!loaded && !loadFinished ? (
            <div className="flex min-h-0 flex-1 items-center justify-center opacity-0" aria-busy="true" />
          ) : !loaded ? (
            <div className="zen-content-enter m-auto flex flex-col items-center gap-2">
              <span role="alert">{t('agent.session.get.error.failed')}</span>
              <Button size="small" onClick={() => void loadHistory()}>
                {t('common.retry')}
              </Button>
            </div>
          ) : !hasMessages ? (
            <div className="zen-content-enter m-auto text-(--color-text-secondary)">{t('history.no_history')}</div>
          ) : (
            <div key={sessionId} className="zen-content-enter flex min-h-0 flex-1 flex-col overflow-hidden">
              <AgentSessionMessages agentId={agentId} sessionId={sessionId} readOnly />
              {messageNavigation === 'buttons' && <ChatNavigation containerId="messages" />}
            </div>
          )}
          <div
            className="pointer-events-none absolute right-0 bottom-0 left-0 z-20 pt-5"
            style={{ background: 'var(--zen-veil-bottom)' }}>
            <div className="pointer-events-auto">
              <LegacyAssistantInputbar />
            </div>
          </div>
        </div>
      </QuickPanelProvider>
    </section>
  )
}
