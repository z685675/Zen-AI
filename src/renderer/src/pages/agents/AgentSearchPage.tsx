import { HStack } from '@renderer/components/Layout'
import { useActiveAgent } from '@renderer/hooks/agents/useActiveAgent'
import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useAgents } from '@renderer/hooks/agents/useAgents'
import { AgentLabel } from '@renderer/pages/settings/AgentSettings/shared'
import { useAppDispatch } from '@renderer/store'
import { setActiveSessionIdAction } from '@renderer/store/runtime'
import type { AgentEntity, AgentSessionSearchResult } from '@renderer/types'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import type { InputRef } from 'antd'
import { Divider, Empty, Input, Spin } from 'antd'
import dayjs from 'dayjs'
import { Archive, Pin, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

type Props = {
  onSelect?: () => void
}

const AgentSearchPage = ({ onSelect }: Props) => {
  const { t } = useTranslation()
  const client = useAgentClient()
  const { agents } = useAgents()
  const { setActiveAgentId } = useActiveAgent()
  const dispatch = useAppDispatch()
  const inputRef = useRef<InputRef>(null)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AgentSessionSearchResult[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const agentsById = useMemo(() => {
    return Object.fromEntries((agents ?? []).map((agent) => [agent.id, agent]))
  }, [agents])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setResults([])
      setIsLoading(false)
      return
    }

    const timer = window.setTimeout(async () => {
      setIsLoading(true)
      try {
        const response = await client.searchSessions({
          query: trimmed,
          archived: 'include',
          limit: 30
        })
        setResults(response.data)
      } catch (error) {
        window.toast.error(formatErrorMessageWithPrefix(error, t('agent.session.search.error')))
      } finally {
        setIsLoading(false)
      }
    }, 220)

    return () => {
      window.clearTimeout(timer)
    }
  }, [client, query, t])

  const handleSelect = useCallback(
    async (result: AgentSessionSearchResult) => {
      await setActiveAgentId(result.session.agent_id)
      dispatch(
        setActiveSessionIdAction({
          agentId: result.session.agent_id,
          sessionId: result.session.id
        })
      )
      onSelect?.()
    },
    [dispatch, onSelect, setActiveAgentId]
  )

  return (
    <Container>
      <HStack style={{ padding: '0 12px', marginTop: 8 }}>
        <Input
          prefix={
            <SearchIcon>
              <Search size={15} />
            </SearchIcon>
          }
          ref={inputRef}
          placeholder={t('agent.session.search.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value.trimStart())}
          allowClear
          autoFocus
          spellCheck={false}
          style={{ paddingLeft: 0 }}
          variant="borderless"
          size="middle"
        />
      </HStack>
      <Divider style={{ margin: 0, marginTop: 4, borderBlockStartWidth: 0.5 }} />

      <ResultsContainer>
        {isLoading ? (
          <CenteredState>
            <Spin />
          </CenteredState>
        ) : !query.trim() ? (
          <CenteredState>
            <Empty description={t('agent.session.search.placeholder')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </CenteredState>
        ) : results.length === 0 ? (
          <CenteredState>
            <Empty description={t('agent.session.search.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </CenteredState>
        ) : (
          results.map((result) => {
            const session = result.session
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
              <ResultCard key={session.id} onClick={() => void handleSelect(result)}>
                <ResultHeader>
                  <ResultTitle>{session.name || session.id}</ResultTitle>
                  <ResultTime>{dayjs(result.matched_at ?? session.updated_at).format('YYYY/MM/DD HH:mm')}</ResultTime>
                </ResultHeader>
                <ResultMeta>
                  <AgentLabel
                    agent={agent}
                    classNames={{ container: 'gap-1', avatar: 'h-3.5 w-3.5', name: 'text-[11px]' }}
                  />
                  {session.is_pinned && (
                    <MetaTag>
                      <Pin size={11} />
                      {t('common.pinned')}
                    </MetaTag>
                  )}
                  {session.is_archived && (
                    <MetaTag>
                      <Archive size={11} />
                      {t('agent.session.archive.badge')}
                    </MetaTag>
                  )}
                </ResultMeta>
                {result.snippet && <ResultSnippet>{result.snippet}</ResultSnippet>}
              </ResultCard>
            )
          })
        )}
      </ResultsContainer>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  height: 100%;
`

const ResultsContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  overflow-y: auto;
  padding: 10px 12px 14px;
  gap: 8px;
`

const CenteredState = styled.div`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
`

const SearchIcon = styled.div`
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  background-color: var(--color-background-soft);
  margin-right: 2px;
`

const ResultCard = styled.button`
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 10px 12px;
  border-radius: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease;

  &:hover {
    background: var(--color-list-item-hover);
  }
`

const ResultHeader = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
`

const ResultTitle = styled.div`
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
`

const ResultTime = styled.div`
  color: var(--color-text-3);
  font-size: 11px;
  white-space: nowrap;
`

const ResultMeta = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  color: var(--color-text-2);
`

const MetaTag = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-3);
  font-size: 10px;
`

const ResultSnippet = styled.div`
  margin-top: 8px;
  color: var(--color-text-2);
  font-size: 12px;
  line-height: 1.5;
`

export default AgentSearchPage
