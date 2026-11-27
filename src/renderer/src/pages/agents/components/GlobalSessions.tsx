import AddButton from '@renderer/components/AddButton'
import DraggableVirtualList, { type DraggableVirtualListRef } from '@renderer/components/DraggableList/virtual-list'
import { useSidebarCreateAction, useSidebarShell } from '@renderer/context/SidebarSlotProvider'
import { useActiveAgent } from '@renderer/hooks/agents/useActiveAgent'
import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useAllSessions } from '@renderer/hooks/agents/useAllSessions'
import { useCreateDefaultSession } from '@renderer/hooks/agents/useCreateDefaultSession'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useShortcutDisplay } from '@renderer/hooks/useShortcuts'
import { DbService } from '@renderer/services/db/DbService'
import store, { useAppDispatch } from '@renderer/store'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import { setActiveSessionIdAction } from '@renderer/store/runtime'
import type { AgentEntity } from '@renderer/types'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { isUnnamedAgentSessionName } from '@renderer/utils/agentSessionTitle'
import { Spin, Tooltip } from 'antd'
import { throttle } from 'lodash'
import { Archive, ArrowLeft, Plus } from 'lucide-react'
import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import SessionItem from './SessionItem'

interface GlobalSessionsProps {
  agentsById: Record<string, AgentEntity>
  onSelectItem?: () => void
  legacyFolder?: ReactNode
  isViewingLegacy?: boolean
}

const LOAD_MORE_THRESHOLD = 100
const SCROLL_THROTTLE_DELAY = 150
type SessionViewMode = 'active' | 'archived'
const dbService = DbService.getInstance()

const GlobalSessions = ({ agentsById, onSelectItem, legacyFolder, isViewingLegacy = false }: GlobalSessionsProps) => {
  const { t } = useTranslation()
  const inSidebar = Boolean(useSidebarShell())
  const newTaskShortcut = useShortcutDisplay('new_topic')
  const [sessionViewMode, setViewMode] = useState<SessionViewMode>('active')
  const viewMode = isViewingLegacy ? 'active' : sessionViewMode
  const folderInList = viewMode === 'active' ? legacyFolder : undefined
  const archivedFilter = viewMode === 'archived' ? 'only' : 'exclude'
  const { sessions, isLoading, error, hasMore, loadMore, isLoadingMore, deleteSession, updateSession } = useAllSessions(
    {
      archived: archivedFilter
    }
  )
  const { chat } = useRuntime()
  const { activeAgentId, activeSessionIdMap } = chat
  const { setActiveAgentId } = useActiveAgent()
  const dispatch = useAppDispatch()
  const listRef = useRef<DraggableVirtualListRef>(null)
  const creatingGlobalSessionRef = useRef(false)
  const client = useAgentClient()
  const { createDefaultSession, creatingSession, canCreateSession } = useCreateDefaultSession(activeAgentId)
  const [creatingGlobalSession, setCreatingGlobalSession] = useState(false)

  const [channelMap, setChannelMap] = useState<Record<string, { type: string; isActive: boolean }>>({})
  useEffect(() => {
    client
      .listChannels()
      .then(({ data }) => {
        const map: Record<string, { type: string; isActive: boolean }> = {}
        for (const ch of data) {
          if (ch.sessionId) {
            map[ch.sessionId] = { type: ch.type, isActive: ch.isActive ?? ch.is_active ?? true }
          }
        }
        setChannelMap(map)
      })
      .catch(() => {})
  }, [client, sessions])

  const hasMoreRef = useRef(hasMore)
  const isLoadingMoreRef = useRef(isLoadingMore)
  const loadMoreRef = useRef(loadMore)
  hasMoreRef.current = hasMore
  isLoadingMoreRef.current = isLoadingMore
  loadMoreRef.current = loadMore

  const showSessionRows = !isLoading && !error && sessions.length > 0
  useEffect(() => {
    if (isViewingLegacy) listRef.current?.scrollToOffset(0)
  }, [isViewingLegacy])

  const handleScroll = useMemo(
    () =>
      throttle(() => {
        const scrollElement = listRef.current?.scrollElement()
        if (!scrollElement) return
        const { scrollTop, scrollHeight, clientHeight } = scrollElement
        if (
          scrollHeight - scrollTop - clientHeight < LOAD_MORE_THRESHOLD &&
          hasMoreRef.current &&
          !isLoadingMoreRef.current
        ) {
          loadMoreRef.current()
        }
      }, SCROLL_THROTTLE_DELAY),
    []
  )

  useEffect(() => {
    if (!showSessionRows) return
    const scrollElement = listRef.current?.scrollElement()
    if (!scrollElement) return

    scrollElement.addEventListener('scroll', handleScroll)
    return () => {
      handleScroll.cancel()
      scrollElement.removeEventListener('scroll', handleScroll)
    }
  }, [handleScroll, showSessionRows])

  const handlePress = useCallback(
    (agentId: string, sessionId: string) => {
      void setActiveAgentId(agentId)
      dispatch(setActiveSessionIdAction({ agentId, sessionId }))
      onSelectItem?.()
    },
    [dispatch, onSelectItem, setActiveAgentId]
  )

  const handleDelete = useCallback(
    async (agentId: string, sessionId: string) => {
      const deleted = await deleteSession(agentId, sessionId)
      if (!deleted) {
        return
      }

      if (activeSessionIdMap[agentId] === sessionId) {
        const replacement = sessions.find((item) => item.agent_id === agentId && item.id !== sessionId)
        if (replacement) {
          void setActiveAgentId(agentId)
          dispatch(setActiveSessionIdAction({ agentId, sessionId: replacement.id }))
        } else {
          dispatch(setActiveSessionIdAction({ agentId, sessionId: null }))
        }
      }
    },
    [activeSessionIdMap, deleteSession, dispatch, sessions, setActiveAgentId]
  )

  const handleTogglePinned = useCallback(
    async (agentId: string, sessionId: string, isPinned: boolean) => {
      await updateSession(agentId, {
        id: sessionId,
        is_pinned: !isPinned
      })
    },
    [updateSession]
  )

  const handleToggleArchived = useCallback(
    async (agentId: string, sessionId: string, isArchived: boolean) => {
      const updated = await updateSession(agentId, {
        id: sessionId,
        is_archived: !isArchived
      })

      if (!updated) {
        return
      }

      if (activeSessionIdMap[agentId] === sessionId && !isArchived) {
        const replacement = sessions.find((item) => item.agent_id === agentId && item.id !== sessionId)
        if (replacement) {
          void setActiveAgentId(agentId)
          dispatch(setActiveSessionIdAction({ agentId, sessionId: replacement.id }))
        } else {
          dispatch(setActiveSessionIdAction({ agentId, sessionId: null }))
        }
      }
    },
    [activeSessionIdMap, dispatch, sessions, setActiveAgentId, updateSession]
  )

  const handleCreateSession = useCallback(async () => {
    if (creatingGlobalSessionRef.current) {
      return
    }

    creatingGlobalSessionRef.current = true
    setCreatingGlobalSession(true)
    if (sessionViewMode !== 'active') {
      setViewMode('active')
    }

    try {
      const unnamedSessionName = t('common.unnamed')
      for (const session of sessions) {
        if (!isUnnamedAgentSessionName(session.name, unnamedSessionName)) {
          continue
        }

        const topicId = buildAgentSessionTopicId(session.id)
        const currentState = store.getState()
        if (currentState.messages.loadingByTopic[topicId] || selectMessagesForTopic(currentState, topicId).length > 0) {
          continue
        }

        const { messages } = await dbService.fetchMessages(topicId, true)
        const latestState = store.getState()
        if (
          latestState.messages.loadingByTopic[topicId] ||
          selectMessagesForTopic(latestState, topicId).length > 0 ||
          messages.length > 0
        ) {
          continue
        }

        if (session.agent_id === activeAgentId) {
          if (await createDefaultSession()) onSelectItem?.()
          return
        }

        await updateSession(session.agent_id, { id: session.id })
        await setActiveAgentId(session.agent_id)
        dispatch(setActiveSessionIdAction({ agentId: session.agent_id, sessionId: session.id }))
        onSelectItem?.()
        return
      }

      if (await createDefaultSession()) onSelectItem?.()
    } finally {
      creatingGlobalSessionRef.current = false
      setCreatingGlobalSession(false)
    }
  }, [
    activeAgentId,
    createDefaultSession,
    dispatch,
    onSelectItem,
    sessions,
    setActiveAgentId,
    t,
    updateSession,
    sessionViewMode
  ])

  useSidebarCreateAction(
    () => {
      void handleCreateSession()
    },
    Boolean(activeAgentId && canCreateSession && !isLoading)
  )

  if (isLoading && !folderInList) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spin />
      </div>
    )
  }

  if (error && !folderInList) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-(--color-error) text-[13px]">
        {t('agent.session.get.error.failed')}
      </div>
    )
  }

  const renderHeaderRow = () => (
    <HeaderRow>
      {viewMode === 'archived' ? (
        <HeaderButton type="button" onClick={() => setViewMode('active')}>
          <ArrowLeft size={14} />
          {t('common.back')}
        </HeaderButton>
      ) : (
        <>
          {inSidebar ? (
            <span className="pl-1 font-semibold text-(--zen-text-1) text-[13.5px] tracking-[-0.01em]">
              {t('common.agent_one')}
            </span>
          ) : activeAgentId && canCreateSession ? (
            <InlineAddButton
              onClick={() => void handleCreateSession()}
              disabled={creatingSession || creatingGlobalSession}>
              {t('agent.session.add.title')}
            </InlineAddButton>
          ) : (
            <HeaderSpacer />
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            {inSidebar && activeAgentId && canCreateSession && (
              <Tooltip
                title={newTaskShortcut ? `${t('app_shell.new_task')} · ${newTaskShortcut}` : t('app_shell.new_task')}
                mouseEnterDelay={0.5}>
                <button
                  type="button"
                  className="zen-section-create-pill"
                  aria-label={t('app_shell.new_task')}
                  disabled={creatingSession || creatingGlobalSession}
                  onClick={() => void handleCreateSession()}>
                  <Plus size={13} strokeWidth={2.3} />
                  <span>{t('common.new')}</span>
                </button>
              </Tooltip>
            )}
            <Tooltip title={t('agent.session.archive.title')} mouseEnterDelay={0.5}>
              <HeaderIconButton
                type="button"
                aria-label={t('agent.session.archive.title')}
                onClick={() => {
                  if (isViewingLegacy) onSelectItem?.()
                  setViewMode('archived')
                }}>
                <Archive size={14} />
              </HeaderIconButton>
            </Tooltip>
          </div>
        </>
      )}
    </HeaderRow>
  )

  if (sessions.length === 0 && !folderInList) {
    return (
      <div className="flex h-full flex-col">
        {renderHeaderRow()}
        <div className="flex flex-1 items-center justify-center px-4 text-(--color-text-secondary) text-[13px]">
          {viewMode === 'archived' ? t('agent.session.archive.empty') : t('history.no_history')}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {renderHeaderRow()}
      <DraggableVirtualList
        ref={listRef}
        className="sessions-tab flex min-h-0 flex-1 flex-col"
        itemStyle={{ marginBottom: 4 }}
        list={showSessionRows ? sessions : []}
        estimateSize={() => 54}
        scrollerStyle={{ overflowX: 'hidden', padding: '4px 10px 14px' }}
        disabled
        itemKey={(index) => sessions[index]?.id ?? index}
        header={
          folderInList && (
            <>
              {folderInList}
              {!showSessionRows && (
                <div className="px-2 py-2 text-(--zen-text-3) text-[12px]">
                  {isLoading ? (
                    <Spin size="small" />
                  ) : error ? (
                    <span role="alert">{t('agent.session.get.error.failed')}</span>
                  ) : (
                    t('history.no_history')
                  )}
                </div>
              )}
            </>
          )
        }>
        {(session) => {
          const agent =
            agentsById[session.agent_id] ??
            ({
              id: session.agent_id,
              name: session.agent_id,
              type: 'claude-code',
              created_at: session.created_at,
              updated_at: session.updated_at,
              accessible_paths: [],
              model: session.model
            } as AgentEntity)
          return (
            <SessionItem
              session={session}
              agent={agent}
              agentId={session.agent_id}
              isActive={
                !isViewingLegacy &&
                activeAgentId === session.agent_id &&
                activeSessionIdMap[session.agent_id] === session.id
              }
              channelType={channelMap[session.id]?.type}
              channelIsActive={channelMap[session.id]?.isActive}
              onDelete={() => {
                void handleDelete(session.agent_id, session.id)
              }}
              onTogglePinned={() => {
                void handleTogglePinned(session.agent_id, session.id, !!session.is_pinned)
              }}
              onToggleArchived={() => {
                void handleToggleArchived(session.agent_id, session.id, !!session.is_archived)
              }}
              onPress={() => {
                handlePress(session.agent_id, session.id)
              }}
            />
          )
        }}
      </DraggableVirtualList>
      {isLoadingMore && (
        <div className="flex justify-center py-2">
          <Spin size="small" />
        </div>
      )}
    </div>
  )
}

const HeaderRow = ({ children }: PropsWithChildren) => (
  <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-1.5">{children}</div>
)

const HeaderButton = ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    type="button"
    className="flex items-center gap-1 rounded-(--zen-radius-sm) border-0 bg-transparent px-2 py-1 text-(--zen-text-3) text-[11.5px] transition-colors hover:bg-(--zen-bg-hover) hover:text-(--zen-text-1)"
    {...props}>
    {children}
  </button>
)

const HeaderIconButton = ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    type="button"
    className="flex h-[26px] w-[26px] items-center justify-center rounded-(--zen-radius-sm) border-0 bg-transparent text-(--zen-text-3) transition-colors hover:bg-(--zen-bg-hover) hover:text-(--zen-text-1)"
    {...props}>
    {children}
  </button>
)

const HeaderSpacer = styled.div`
  flex: 1;
  min-width: 0;
`

const InlineAddButton = styled(AddButton)`
  width: auto;
  min-width: 0;
  height: 28px;
  min-height: 28px;
  padding: 0 10px;
  font-size: 12px;
  color: var(--color-text-secondary);
`

export default memo(GlobalSessions)
