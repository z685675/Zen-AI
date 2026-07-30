import AddButton from '@renderer/components/AddButton'
import DraggableVirtualList, { type DraggableVirtualListRef } from '@renderer/components/DraggableList/virtual-list'
import { useActiveAgent } from '@renderer/hooks/agents/useActiveAgent'
import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useAllSessions } from '@renderer/hooks/agents/useAllSessions'
import { useCreateDefaultSession } from '@renderer/hooks/agents/useCreateDefaultSession'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useAppDispatch } from '@renderer/store'
import { setActiveSessionIdAction } from '@renderer/store/runtime'
import type { AgentEntity } from '@renderer/types'
import { Spin } from 'antd'
import { throttle } from 'lodash'
import { Archive, ArrowLeft } from 'lucide-react'
import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import SessionItem from './SessionItem'

interface GlobalSessionsProps {
  agentsById: Record<string, AgentEntity>
  onSelectItem?: () => void
}

const LOAD_MORE_THRESHOLD = 100
const SCROLL_THROTTLE_DELAY = 150
type SessionViewMode = 'active' | 'archived'

const GlobalSessions = ({ agentsById, onSelectItem }: GlobalSessionsProps) => {
  const { t } = useTranslation()
  const [viewMode, setViewMode] = useState<SessionViewMode>('active')
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
  const client = useAgentClient()
  const { createDefaultSession, creatingSession, canCreateSession } = useCreateDefaultSession(activeAgentId)

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
    const scrollElement = listRef.current?.scrollElement()
    if (!scrollElement) return

    scrollElement.addEventListener('scroll', handleScroll)
    return () => {
      handleScroll.cancel()
      scrollElement.removeEventListener('scroll', handleScroll)
    }
  }, [handleScroll])

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

  const handleCreateSession = useCallback(() => {
    if (viewMode !== 'active') {
      setViewMode('active')
    }
    void createDefaultSession()
  }, [createDefaultSession, viewMode])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spin />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-(--color-error) text-[13px]">
        {t('agent.session.get.error.failed')}
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <HeaderRow>
          {viewMode === 'archived' ? (
            <HeaderButton type="button" onClick={() => setViewMode('active')}>
              <ArrowLeft size={14} />
              {t('common.back')}
            </HeaderButton>
          ) : (
            <>
              {activeAgentId && canCreateSession && (
                <InlineAddButton onClick={handleCreateSession} disabled={creatingSession}>
                  {t('agent.session.add.title')}
                </InlineAddButton>
              )}
              {(!activeAgentId || !canCreateSession) && <HeaderSpacer />}
            </>
          )}
          {viewMode === 'active' && (
            <HeaderButton type="button" onClick={() => setViewMode('archived')}>
              <Archive size={14} />
              {t('agent.session.archive.title')}
            </HeaderButton>
          )}
        </HeaderRow>
        <div className="flex flex-1 items-center justify-center px-4 text-(--color-text-secondary) text-[13px]">
          {viewMode === 'archived' ? t('agent.session.archive.empty') : t('history.no_history')}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <HeaderRow>
        {viewMode === 'archived' ? (
          <HeaderButton type="button" onClick={() => setViewMode('active')}>
            <ArrowLeft size={14} />
            {t('common.back')}
          </HeaderButton>
        ) : (
          <>
            {activeAgentId && canCreateSession && (
              <InlineAddButton onClick={handleCreateSession} disabled={creatingSession}>
                {t('agent.session.add.title')}
              </InlineAddButton>
            )}
            {(!activeAgentId || !canCreateSession) && <HeaderSpacer />}
          </>
        )}
        {viewMode === 'active' && (
          <HeaderButton type="button" onClick={() => setViewMode('archived')}>
            <Archive size={14} />
            {t('agent.session.archive.title')}
          </HeaderButton>
        )}
      </HeaderRow>
      <DraggableVirtualList
        ref={listRef}
        className="sessions-tab flex min-h-0 flex-1 flex-col"
        itemStyle={{ marginBottom: 8 }}
        list={sessions}
        estimateSize={() => 14 * 4}
        scrollerStyle={{ overflowX: 'hidden', padding: '2px 10px 12px' }}
        disabled
        itemKey={(index) => sessions[index]?.id ?? index}
        header={null}>
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
              isActive={activeAgentId === session.agent_id && activeSessionIdMap[session.agent_id] === session.id}
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
  <div className="flex items-center justify-between gap-3 px-3 pt-2 pb-1">{children}</div>
)

const HeaderButton = ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    type="button"
    className="flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 text-(--color-text-secondary) text-[12px] transition-colors hover:bg-(--color-list-item-hover) hover:text-(--color-text)"
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
