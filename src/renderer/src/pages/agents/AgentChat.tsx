import { loggerService } from '@logger'
import { DEFAULT_SESSION_PAGE_SIZE } from '@renderer/api/agent'
import EmojiIcon from '@renderer/components/EmojiIcon'
import { QuickPanelProvider } from '@renderer/components/QuickPanel'
import {
  findAgentModelId,
  getAgentModelProviderId,
  isAssistantModelIdentifierAllowed,
  isAssistantModelIdentifierBlocked
} from '@renderer/config/agentModelPolicy'
import { useActiveAgent } from '@renderer/hooks/agents/useActiveAgent'
import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useAgents } from '@renderer/hooks/agents/useAgents'
import { useCreateDefaultSession } from '@renderer/hooks/agents/useCreateDefaultSession'
import { useSession } from '@renderer/hooks/agents/useSession'
import { useUpdateSession } from '@renderer/hooks/agents/useUpdateSession'
import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants } from '@renderer/hooks/useStore'
import {
  ASSISTANT_DEPENDENCY_I18N_KEYS,
  type AssistantEnvironmentCheckResult,
  checkAssistantEnvironmentWithCache,
  getFreshAssistantEnvironmentCache,
  REQUIRED_ASSISTANT_DEPENDENCIES,
  subscribeAssistantEnvironment
} from '@renderer/services/AssistantEnvironmentService'
import { CacheService } from '@renderer/services/CacheService'
import { DbService } from '@renderer/services/db/DbService'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import { setActiveSessionIdAction } from '@renderer/store/runtime'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { GetAgentSessionResponse, ListAgentSessionsResponse } from '@renderer/types'
import { cn } from '@renderer/utils'
import { buildAgentSessionTopicId, getChannelTypeIcon } from '@renderer/utils/agentSession'
import { getAgentSessionDraftCacheKey } from '@renderer/utils/agentSessionDraft'
import { isUnnamedAgentSessionName } from '@renderer/utils/agentSessionTitle'
import { shouldDiscardEmptyConversation } from '@renderer/utils/conversationDraft'
import { DEFAULT_FUSION_AGENT_ID, getAgentAvatar } from '@shared/config/agents'
import { Alert, Button, Spin, Tooltip } from 'antd'
import {
  CalendarClock,
  FolderOpen,
  ListTodo,
  PanelLeftOpen,
  Puzzle,
  RefreshCw,
  ScrollText,
  Search,
  Sparkles,
  Wrench
} from 'lucide-react'
import type { PropsWithChildren, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { mutate } from 'swr'
import { unstable_serialize } from 'swr/infinite'

import { PinnedTodoPanel } from '../home/Inputbar/components/PinnedTodoPanel'
import ChatNavigation from '../home/Messages/ChatNavigation'
import NarrowLayout from '../home/Messages/NarrowLayout'
import AgentChatNavbar from './components/AgentChatNavbar'
import AgentQuickEntryModal, { type AgentQuickEntry } from './components/AgentQuickEntryModal'
import AgentSessionInputbar from './components/AgentSessionInputbar'
import AgentSessionMessages from './components/AgentSessionMessages'
import AgentTaskStatusBar from './components/AgentTaskStatusBar'
import SessionModelSelectButton from './components/SessionModelSelectButton'

type CapabilityCardItem = {
  key: string
  title: string
  description: string
  icon: ReactNode
}

type QuickEntryItem = {
  key: string
  title: string
  description: string
  icon: ReactNode
  onClick: () => void
}

type TrackedAgentSession = {
  agentId: string
  session: GetAgentSessionResponse
}

const logger = loggerService.withContext('AgentChat')
const dbService = DbService.getInstance()
const EMPTY_SESSION_LOADING_RETRY_DELAY_MS = 100
const EMPTY_SESSION_LOADING_RETRY_ATTEMPTS = 30

const AgentChat = () => {
  const { t } = useTranslation()
  const { messageNavigation, messageStyle } = useSettings()
  const { showAssistants, setShowAssistants } = useShowAssistants()
  const dispatch = useAppDispatch()
  const { chat } = useRuntime()
  const { activeAgentId, activeSessionIdMap, isMultiSelectMode } = chat
  const activeSessionId = activeAgentId ? activeSessionIdMap[activeAgentId] : null
  const isSessionInitialized = !activeAgentId || activeAgentId in activeSessionIdMap
  const { agent: activeAgent, isLoading: isAgentLoading } = useActiveAgent()
  const { isLoading: isAgentsLoading, agents } = useAgents()
  const client = useAgentClient()
  const { createDefaultSession } = useCreateDefaultSession(activeAgentId)
  const { updateSession } = useUpdateSession(activeAgentId)
  const { session: activeSession } = useSession(activeAgentId, activeSessionId)
  const sessionTopicId = activeSessionId ? buildAgentSessionTopicId(activeSessionId) : ''
  const messages = useTopicMessages(sessionTopicId)
  const hasLoadedSessionMessages = useAppSelector((state) =>
    sessionTopicId ? !!state.messages.loadedByTopic[sessionTopicId] : false
  )
  const isActiveSessionLoading = useAppSelector((state) =>
    sessionTopicId ? Boolean(state.messages.loadingByTopic[sessionTopicId]) : false
  )
  const modelPolicy = useAppSelector((state) => state.llm.modelPolicy)
  const isWelcomeState = hasLoadedSessionMessages && messages.length === 0
  const isSessionMessagesBootstrapping = !!activeSessionId && !!sessionTopicId && !hasLoadedSessionMessages
  const [initialEnvironmentCache] = useState(() => getFreshAssistantEnvironmentCache())
  const [environmentChecking, setEnvironmentChecking] = useState(!initialEnvironmentCache)
  const [environmentResult, setEnvironmentResult] = useState<AssistantEnvironmentCheckResult | null>(
    initialEnvironmentCache?.result ?? null
  )
  const [environmentError, setEnvironmentError] = useState<string | null>(initialEnvironmentCache?.error ?? null)
  const [quickEntry, setQuickEntry] = useState<AgentQuickEntry | null>(null)
  const trackedSessionRef = useRef<TrackedAgentSession | undefined>(undefined)
  const sessionsBeingDiscardedRef = useRef(new Set<string>())
  const modelRepairAttemptsRef = useRef(new Set<string>())

  const discardAbandonedSession = useCallback(
    async ({ agentId, session }: TrackedAgentSession) => {
      if (!isUnnamedAgentSessionName(session.name, t('common.unnamed'))) {
        return
      }

      const sessionKey = `${agentId}:${session.id}`
      if (sessionsBeingDiscardedRef.current.has(sessionKey)) {
        return
      }

      const topicId = buildAgentSessionTopicId(session.id)
      const draftCacheKey = getAgentSessionDraftCacheKey(agentId, session.id)
      sessionsBeingDiscardedRef.current.add(sessionKey)
      try {
        let latestState = store.getState()
        for (let attempt = 0; attempt < EMPTY_SESSION_LOADING_RETRY_ATTEMPTS; attempt += 1) {
          const messageCount = selectMessagesForTopic(latestState, topicId).length
          if (
            !shouldDiscardEmptyConversation({
              draft: CacheService.get(draftCacheKey),
              isLoading: false,
              messageCount
            })
          ) {
            return
          }

          if (!latestState.messages.loadingByTopic[topicId]) {
            break
          }

          await new Promise((resolve) => setTimeout(resolve, EMPTY_SESSION_LOADING_RETRY_DELAY_MS))
          latestState = store.getState()
        }

        if (
          !shouldDiscardEmptyConversation({
            draft: CacheService.get(draftCacheKey),
            isLoading: Boolean(latestState.messages.loadingByTopic[topicId]),
            messageCount: selectMessagesForTopic(latestState, topicId).length
          })
        ) {
          return
        }

        const persisted = await dbService.fetchMessages(topicId, true)
        latestState = store.getState()
        const messageCount = Math.max(persisted.messages.length, selectMessagesForTopic(latestState, topicId).length)

        if (
          !shouldDiscardEmptyConversation({
            draft: CacheService.get(draftCacheKey),
            isLoading: Boolean(latestState.messages.loadingByTopic[topicId]),
            messageCount
          })
        ) {
          return
        }

        await client.deleteSession(agentId, session.id)
        CacheService.remove(draftCacheKey)
        dispatch(newMessagesActions.clearTopicMessages(topicId))

        if (store.getState().runtime.chat.activeSessionIdMap[agentId] === session.id) {
          dispatch(setActiveSessionIdAction({ agentId, sessionId: null }))
        }

        const paths = client.getSessionPaths(agentId)
        const sessionListKey = unstable_serialize(() => [paths.base, 0, DEFAULT_SESSION_PAGE_SIZE])
        const archivedFilters = session.is_archived ? (['include', 'only'] as const) : (['exclude', 'include'] as const)
        const allSessionListKeys = archivedFilters.map((archived) =>
          unstable_serialize(() => [client.allSessionsPath, archived, 0, DEFAULT_SESSION_PAGE_SIZE])
        )
        const removeSessionFromPages = (pages: ListAgentSessionsResponse[] | undefined) => {
          if (!pages?.some((page) => page.data.some((item) => item.id === session.id))) {
            return pages
          }

          return pages.map((page) => ({
            ...page,
            data: page.data.filter((item) => item.id !== session.id),
            total: Math.max(0, page.total - 1)
          }))
        }

        await Promise.all([
          mutate(paths.withId(session.id), undefined, { revalidate: false }),
          mutate<ListAgentSessionsResponse[]>(sessionListKey, removeSessionFromPages, { revalidate: true }),
          ...allSessionListKeys.map((key) =>
            mutate<ListAgentSessionsResponse[]>(key, removeSessionFromPages, { revalidate: true })
          )
        ])
      } catch (error) {
        logger.warn('Failed to discard an abandoned empty Agent session', error as Error)
      } finally {
        sessionsBeingDiscardedRef.current.delete(sessionKey)
      }
    },
    [client, dispatch, t]
  )

  const discardAbandonedSessionRef = useRef(discardAbandonedSession)
  discardAbandonedSessionRef.current = discardAbandonedSession

  useEffect(() => {
    const previousSession = trackedSessionRef.current
    let loadedCurrentSession: TrackedAgentSession | undefined
    if (activeAgentId && activeSessionId && activeSession && activeSession.id === activeSessionId) {
      loadedCurrentSession = { agentId: activeAgentId, session: activeSession }
    }
    const currentSession =
      loadedCurrentSession ??
      (previousSession && previousSession.agentId === activeAgentId && previousSession.session.id === activeSessionId
        ? previousSession
        : undefined)
    trackedSessionRef.current = currentSession

    if (
      previousSession &&
      (!currentSession ||
        previousSession.agentId !== currentSession.agentId ||
        previousSession.session.id !== currentSession.session.id)
    ) {
      void discardAbandonedSession(previousSession)
    }
  }, [activeAgentId, activeSession, activeSessionId, discardAbandonedSession])

  useEffect(
    () => () => {
      const currentSession = trackedSessionRef.current
      if (currentSession) {
        void discardAbandonedSessionRef.current(currentSession)
      }
    },
    []
  )

  useEffect(() => {
    if (
      !activeAgentId ||
      !activeSession ||
      !hasLoadedSessionMessages ||
      isActiveSessionLoading ||
      messages.length > 0 ||
      !isUnnamedAgentSessionName(activeSession.name, t('common.unnamed')) ||
      isAssistantModelIdentifierAllowed(activeSession.model, false, modelPolicy?.policy) ||
      modelRepairAttemptsRef.current.has(activeSession.id)
    ) {
      return
    }

    modelRepairAttemptsRef.current.add(activeSession.id)
    const repairLegacyModel = async () => {
      try {
        const { data } = await client.getModels({ limit: 1000 })
        const configuredDefault =
          modelPolicy?.policy.rules.applyToNewSessions === false
            ? undefined
            : modelPolicy?.policy.defaults.assistantNewSession
        if (!configuredDefault) return
        const currentDefaultModel = findAgentModelId(
          data,
          configuredDefault,
          getAgentModelProviderId(activeSession.model)
        )
        if (currentDefaultModel) {
          await updateSession(
            {
              id: activeSession.id,
              model: currentDefaultModel
            },
            { showSuccessToast: false }
          )
        }
      } catch (error) {
        modelRepairAttemptsRef.current.delete(activeSession.id)
        logger.warn('Failed to align an empty Agent session with the current default model', error as Error)
      }
    }

    void repairLegacyModel()
  }, [
    activeAgentId,
    activeSession,
    client,
    hasLoadedSessionMessages,
    isActiveSessionLoading,
    messages.length,
    modelPolicy?.policy,
    t,
    updateSession
  ])

  useEffect(() => {
    if (
      !activeAgentId ||
      !activeSession ||
      !hasLoadedSessionMessages ||
      isActiveSessionLoading ||
      !modelPolicy?.policy ||
      !isAssistantModelIdentifierBlocked(activeSession.model, modelPolicy.policy) ||
      modelRepairAttemptsRef.current.has(activeSession.id)
    ) {
      return
    }

    modelRepairAttemptsRef.current.add(activeSession.id)
    const repairBlockedModel = async () => {
      try {
        const { data } = await client.getModels({ limit: 1000 })
        const fallbackCandidates = [
          ...modelPolicy.policy.assistant.fallbackModels,
          ...(modelPolicy.policy.rules.applyToNewSessions === false
            ? []
            : [modelPolicy.policy.defaults.assistantNewSession])
        ]
        const fallbackModel = fallbackCandidates
          .map((candidate) => findAgentModelId(data, candidate, getAgentModelProviderId(activeSession.model)))
          .find(
            (candidate): candidate is string =>
              Boolean(candidate) && isAssistantModelIdentifierAllowed(candidate, false, modelPolicy.policy)
          )

        if (!fallbackModel) {
          window.toast.error(
            t('agent.modelPolicy.noFallback', '当前模型已停用，且没有可用的备用模型，请在模型设置中选择其他模型。')
          )
          return
        }

        const currentState = store.getState()
        if (currentState.runtime.chat.activeSessionIdMap[activeAgentId] !== activeSession.id) return

        const updated = await updateSession(
          {
            id: activeSession.id,
            model: fallbackModel
          },
          { showSuccessToast: false }
        )
        if (updated) {
          window.toast.info(
            t('agent.modelPolicy.switched', '当前模型已停用，本次会话已切换至备用模型，原有上下文已保留。')
          )
        }
      } catch (error) {
        modelRepairAttemptsRef.current.delete(activeSession.id)
        logger.warn('Failed to switch an existing Agent session away from a blocked model', error as Error)
      }
    }

    void repairBlockedModel()
  }, [
    activeAgentId,
    activeSession,
    client,
    hasLoadedSessionMessages,
    isActiveSessionLoading,
    modelPolicy?.policy,
    t,
    updateSession
  ])

  const checkAssistantEnvironment = useCallback(
    async (options?: { blocking?: boolean }) => {
      const blocking = options?.blocking ?? true
      try {
        if (blocking) {
          setEnvironmentChecking(true)
          setEnvironmentError(null)
        }
        const nextResult = await checkAssistantEnvironmentWithCache({ force: true })
        setEnvironmentResult(nextResult)
      } catch (error: any) {
        const errorMessage = error?.message || t('agent.environmentGate.checkFailed')
        setEnvironmentError(errorMessage)
        setEnvironmentResult(null)
      } finally {
        if (blocking) {
          setEnvironmentChecking(false)
        }
      }
    },
    [t]
  )

  useEffect(() => {
    void checkAssistantEnvironment({ blocking: !initialEnvironmentCache })
  }, [checkAssistantEnvironment, initialEnvironmentCache])

  useEffect(
    () =>
      subscribeAssistantEnvironment(({ result, error }) => {
        setEnvironmentResult(result)
        setEnvironmentError(error)
      }),
    []
  )

  const missingRequiredDependencies = useMemo(
    () => REQUIRED_ASSISTANT_DEPENDENCIES.filter((id) => !environmentResult?.[id]?.installed),
    [environmentResult]
  )
  const hasMissingRequiredEnvironment =
    !environmentChecking && (!!environmentError || (!!environmentResult && missingRequiredDependencies.length > 0))

  useEffect(() => {
    if (!activeSessionId || !sessionTopicId) {
      return
    }

    void dispatch(loadTopicMessagesThunk(sessionTopicId))
  }, [activeSessionId, dispatch, sessionTopicId])

  const capabilityItems = useMemo<CapabilityCardItem[]>(
    () => [
      {
        key: 'search',
        title: t('agent.welcome.capabilities.search', '搜索资料'),
        description: t('agent.welcome.capabilities.search_desc', '先帮你查找信息，再提炼重点和结论。'),
        icon: <Search size={16} />
      },
      {
        key: 'summary',
        title: t('agent.welcome.capabilities.summary', '整理总结'),
        description: t('agent.welcome.capabilities.summary_desc', '把零散内容整理成清晰、可继续使用的结果。'),
        icon: <ScrollText size={16} />
      },
      {
        key: 'files',
        title: t('agent.welcome.capabilities.files', '处理文件'),
        description: t('agent.welcome.capabilities.files_desc', '可结合文件、目录和工作区内容一起完成任务。'),
        icon: <FolderOpen size={16} />
      },
      {
        key: 'tasks',
        title: t('agent.welcome.capabilities.tasks', '连续任务'),
        description: t('agent.welcome.capabilities.tasks_desc', '适合需要多步推进、持续执行的复杂工作。'),
        icon: <ListTodo size={16} />
      }
    ],
    [t]
  )

  const quickEntryItems = useMemo<QuickEntryItem[]>(
    () => [
      {
        key: 'wechat',
        title: '微信接入',
        description: '手机微信文字对话',
        icon: getChannelTypeIcon('wechat') ? (
          <QuickEntryImage src={getChannelTypeIcon('wechat')} alt="WeChat" />
        ) : (
          <Sparkles size={16} />
        ),
        onClick: () => window.navigate(`/settings/channels?type=wechat&open=1&agentId=${DEFAULT_FUSION_AGENT_ID}`)
      },
      {
        key: 'tasks',
        title: t('settings.scheduledTasks.title'),
        description: t('agent.welcome.quick_entries.tasks_desc', '让智能助手按计划自动执行任务'),
        icon: <CalendarClock size={19} />,
        onClick: () => setQuickEntry('tasks')
      },
      {
        key: 'skills',
        title: t('settings.skills.title'),
        description: t('agent.welcome.quick_entries.skills_desc', '导入、搜索和管理智能助手技能'),
        icon: <Puzzle size={19} />,
        onClick: () => setQuickEntry('skills')
      }
    ],
    [t]
  )

  const renderQuickEntrySection = () => (
    <QuickEntrySection>
      <QuickEntryLabel>快捷入口</QuickEntryLabel>
      <QuickEntryGrid>
        {quickEntryItems.map((item) => (
          <QuickEntryButton key={item.key} type="button" onClick={item.onClick}>
            <QuickEntryIcon>{item.icon}</QuickEntryIcon>
            <QuickEntryBody>
              <QuickEntryTitle>{item.title}</QuickEntryTitle>
              <QuickEntryDescription>{item.description}</QuickEntryDescription>
            </QuickEntryBody>
          </QuickEntryButton>
        ))}
      </QuickEntryGrid>
    </QuickEntrySection>
  )

  useShortcut(
    'new_topic',
    () => {
      void createDefaultSession()
    },
    {
      enabled: !hasMissingRequiredEnvironment,
      preventDefault: true,
      enableOnFormTags: true
    }
  )

  const isInitializing =
    environmentChecking ||
    isAgentsLoading ||
    isAgentLoading ||
    !isSessionInitialized ||
    !agents ||
    (!activeAgentId && agents.length > 0)
  const brandAvatar = getAgentAvatar(DEFAULT_FUSION_AGENT_ID)

  if (isInitializing) {
    return (
      <Container className="flex flex-1 flex-col items-center justify-center">
        <Spin />
      </Container>
    )
  }

  if (hasMissingRequiredEnvironment) {
    return (
      <Container className="flex flex-1 flex-col items-center justify-center">
        <EnvironmentGateCard>
          <EnvironmentGateIcon>
            <Wrench size={24} />
          </EnvironmentGateIcon>
          <EnvironmentGateTitle>{t('agent.environmentGate.title')}</EnvironmentGateTitle>
          <EnvironmentGateDescription>{t('agent.environmentGate.description')}</EnvironmentGateDescription>
          <EnvironmentGateHint>{t('agent.environmentGate.repairHint')}</EnvironmentGateHint>
          {environmentError ? (
            <EnvironmentGateError>{environmentError}</EnvironmentGateError>
          ) : (
            <EnvironmentDependencyList>
              {missingRequiredDependencies.map((id) => (
                <EnvironmentDependencyPill key={id}>
                  {t(ASSISTANT_DEPENDENCY_I18N_KEYS[id].name)}
                </EnvironmentDependencyPill>
              ))}
            </EnvironmentDependencyList>
          )}
          <EnvironmentGateActions>
            <Button type="primary" onClick={() => window.navigate('/settings/assistant-environment')}>
              {t('agent.environmentGate.action')}
            </Button>
            <Button
              icon={<RefreshCw size={14} />}
              onClick={() => checkAssistantEnvironment()}
              loading={environmentChecking}>
              {t('agent.environmentGate.refresh')}
            </Button>
          </EnvironmentGateActions>
        </EnvironmentGateCard>
      </Container>
    )
  }

  if (!activeAgentId) {
    return (
      <Container className="flex flex-1 flex-col justify-between">
        <div className="flex h-full w-full items-center justify-center">
          <Alert type="info" message={t('chat.alerts.select_agent')} style={{ margin: '5px 16px' }} />
        </div>
      </Container>
    )
  }

  if (!activeSessionId) {
    return (
      <Container className="flex flex-1 flex-col justify-between">
        <div className="flex h-full w-full items-center justify-center">
          <Alert type="warning" message={t('chat.alerts.create_session')} style={{ margin: '5px 16px' }} />
        </div>
      </Container>
    )
  }

  if (isSessionMessagesBootstrapping) {
    return (
      <Container className="flex flex-1 flex-col items-center justify-center">
        <Spin />
      </Container>
    )
  }

  return (
    <Container className={cn(messageStyle, { 'multi-select-mode': isMultiSelectMode })}>
      <QuickPanelProvider>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-fit w-full min-w-0">
            {!isWelcomeState && activeAgent && <AgentChatNavbar className="min-w-0" activeAgent={activeAgent} />}
          </div>

          <div className="translate-z-0 relative flex w-full flex-1 flex-col justify-between overflow-y-auto overflow-x-hidden">
            {isWelcomeState ? (
              <WelcomeState>
                {!showAssistants && (
                  <Tooltip title={t('navbar.show_sidebar')} mouseEnterDelay={0.5}>
                    <WelcomeSidebarToggle
                      type="button"
                      aria-label={t('navbar.show_sidebar')}
                      onClick={() => setShowAssistants(true)}>
                      <PanelLeftOpen size={17} />
                    </WelcomeSidebarToggle>
                  </Tooltip>
                )}
                <WelcomeInner>
                  <BrandHeader>
                    <BrandMark>
                      <EmojiIcon emoji={brandAvatar} size={30} className="h-[30px] w-[30px]" />
                      <BrandText>智能助手</BrandText>
                    </BrandMark>
                  </BrandHeader>
                  <WelcomeTitle>{t('agent.welcome.title', '把任务交给我，轻松一点开始')}</WelcomeTitle>
                  <CapabilityGrid>
                    {capabilityItems.map((item) => (
                      <CapabilityCard key={item.key}>
                        <CapabilityIcon>{item.icon}</CapabilityIcon>
                        <CapabilityContent>
                          <CapabilityTitle>{item.title}</CapabilityTitle>
                          <CapabilityDescription>{item.description}</CapabilityDescription>
                        </CapabilityContent>
                      </CapabilityCard>
                    ))}
                  </CapabilityGrid>
                  <WelcomeComposer>
                    {activeSession && (
                      <WelcomeModelRow>
                        <WelcomeModelLabel>{t('agent.welcome.model_label', '本次对话模型')}</WelcomeModelLabel>
                        <SessionModelSelectButton
                          agentId={activeAgentId}
                          session={activeSession}
                          persistAsDefault
                          className="min-w-0 max-w-full"
                          buttonStyle={{
                            minHeight: 32,
                            maxWidth: '100%',
                            padding: '4px 10px',
                            border: '1px solid var(--color-border)'
                          }}
                        />
                      </WelcomeModelRow>
                    )}
                    <AgentSessionInputbar agentId={activeAgentId} sessionId={activeSessionId} variant="hero" />
                  </WelcomeComposer>
                  {renderQuickEntrySection()}
                </WelcomeInner>
              </WelcomeState>
            ) : (
              <>
                <AgentSessionMessages agentId={activeAgentId} sessionId={activeSessionId} />
                <div className="mt-auto px-4.5 pb-2">
                  <NarrowLayout contentMaxWidth="960px">
                    <AgentTaskStatusBar topicId={buildAgentSessionTopicId(activeSessionId)} />
                    <PinnedTodoPanel topicId={buildAgentSessionTopicId(activeSessionId)} />
                  </NarrowLayout>
                </div>
                {messageNavigation === 'buttons' && <ChatNavigation containerId="messages" />}
              </>
            )}
          </div>

          {!isWelcomeState && <AgentSessionInputbar agentId={activeAgentId} sessionId={activeSessionId} />}
        </div>
      </QuickPanelProvider>
      <AgentQuickEntryModal entry={quickEntry} onClose={() => setQuickEntry(null)} />
    </Container>
  )
}

const WelcomeState = styled.div`
  display: flex;
  flex: 1;
  align-items: flex-start;
  justify-content: center;
  padding: 26px 26px 22px;
  position: relative;
  overflow: hidden;

  @media (max-height: 880px) {
    padding: 14px 24px 12px;
    overflow-x: hidden;
    overflow-y: auto;
  }

  &::before {
    content: '';
    position: absolute;
    inset: -120px auto auto -120px;
    width: 320px;
    height: 320px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255, 221, 226, 0.7) 0%, rgba(255, 221, 226, 0) 72%);
    pointer-events: none;
  }

  &::after {
    content: '';
    position: absolute;
    right: -120px;
    bottom: -140px;
    width: 360px;
    height: 360px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255, 240, 204, 0.58) 0%, rgba(255, 240, 204, 0) 72%);
    pointer-events: none;
  }
`

const WelcomeSidebarToggle = styled.button`
  position: absolute;
  top: 12px;
  left: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-2);
  cursor: pointer;

  &:hover {
    background: var(--color-background-mute);
    color: var(--color-text);
  }
`

const WelcomeInner = styled.div`
  width: 100%;
  max-width: 1120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  z-index: 1;
  padding: 18px 0 40px;

  @media (max-height: 880px) {
    padding: 8px 0 18px;
  }
`

const BrandHeader = styled.div`
  width: 100%;
  max-width: 1040px;
  display: flex;
  justify-content: flex-start;
`

const BrandMark = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px 10px 10px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.64);
  border: 1px solid rgba(255, 255, 255, 0.72);
  box-shadow:
    0 12px 28px rgba(15, 23, 42, 0.04),
    0 1px 0 rgba(255, 255, 255, 0.85) inset;
  backdrop-filter: blur(10px);
`

const BrandText = styled.span`
  font-size: 18px;
  line-height: 1;
  font-weight: 600;
  color: #d9485f;
`

const WelcomeTitle = styled.h1`
  margin: 28px 0 0;
  font-size: 32px;
  line-height: 1.18;
  font-weight: 500;
  color: #2b2f36;
  text-align: center;
  letter-spacing: -0.03em;

  @media (max-height: 880px) {
    margin-top: 16px;
    font-size: 28px;
  }
`

const CapabilityGrid = styled.div`
  width: 100%;
  max-width: 940px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 30px;

  @media (max-height: 880px) {
    gap: 10px;
    margin-top: 18px;
  }

  @media (max-width: 820px) {
    grid-template-columns: 1fr;
  }
`

const CapabilityCard = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 15px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.46);
  border: 1px solid rgba(255, 255, 255, 0.62);
  box-shadow:
    0 8px 22px rgba(15, 23, 42, 0.03),
    0 1px 0 rgba(255, 255, 255, 0.78) inset;
  backdrop-filter: blur(10px);

  @media (max-height: 880px) {
    gap: 10px;
    padding: 10px 13px;
  }
`

const CapabilityIcon = styled.div`
  width: 34px;
  height: 34px;
  min-width: 34px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(226, 93, 116, 0.82);
  background: linear-gradient(135deg, rgba(255, 235, 239, 0.72), rgba(255, 245, 228, 0.72));
`

const CapabilityContent = styled.div`
  display: flex;
  flex-direction: column;
  min-width: 0;
`

const CapabilityTitle = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: rgba(48, 54, 66, 0.9);
`

const CapabilityDescription = styled.div`
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.65;
  color: rgba(138, 146, 160, 0.88);

  @media (max-height: 880px) {
    line-height: 1.42;
  }
`

const WelcomeComposer = styled.div`
  width: 100%;
  max-width: 1040px;
  margin-top: 28px;

  @media (max-height: 880px) {
    margin-top: 18px;
  }
`

const WelcomeModelRow = styled.div`
  display: flex;
  min-width: 0;
  min-height: 34px;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 10px;
  margin-bottom: 8px;

  & > button {
    min-width: 0;
    max-width: min(420px, 72%);
  }
`

const WelcomeModelLabel = styled.span`
  flex-shrink: 0;
  color: var(--color-text-2);
  font-size: 12px;
  line-height: 1.4;
`

const QuickEntrySection = styled.div`
  width: 100%;
  max-width: 1040px;
  margin-top: 56px;
  padding: 18px 20px 20px;
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(255, 255, 255, 0.76);
  box-shadow:
    0 16px 40px rgba(15, 23, 42, 0.05),
    0 1px 0 rgba(255, 255, 255, 0.88) inset;
  backdrop-filter: blur(14px);

  @media (max-height: 880px) {
    margin-top: 24px;
    padding: 12px 16px 14px;
    border-radius: 24px;
  }
`

const QuickEntryLabel = styled.div`
  margin-bottom: 14px;
  font-size: 12px;
  font-weight: 600;
  color: #7d8794;
  letter-spacing: 0.04em;

  @media (max-height: 880px) {
    margin-bottom: 10px;
  }
`

const QuickEntryGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;

  @media (max-width: 1040px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  @media (max-width: 820px) {
    grid-template-columns: 1fr;
  }
`

const QuickEntryButton = styled.button`
  display: flex;
  align-items: flex-start;
  gap: 14px;
  min-height: 92px;
  padding: 18px 18px;
  border: 1px solid rgba(245, 223, 226, 0.7);
  border-radius: 22px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(255, 250, 247, 0.9)),
    linear-gradient(135deg, rgba(255, 235, 239, 0.24), rgba(255, 245, 228, 0.24));
  box-shadow:
    0 12px 28px rgba(15, 23, 42, 0.04),
    0 1px 0 rgba(255, 255, 255, 0.92) inset;
  cursor: pointer;
  text-align: left;
  transition:
    transform 0.16s ease,
    box-shadow 0.16s ease,
    border-color 0.16s ease,
    background 0.16s ease;

  &:hover {
    transform: translateY(-1px);
    border-color: rgba(244, 114, 125, 0.28);
    box-shadow:
      0 18px 34px rgba(15, 23, 42, 0.06),
      0 1px 0 rgba(255, 255, 255, 0.94) inset;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(255, 248, 244, 0.94)),
      linear-gradient(135deg, rgba(255, 235, 239, 0.28), rgba(255, 245, 228, 0.28));
  }

  @media (max-height: 880px) {
    min-height: 76px;
    padding: 13px 16px;
  }
`

const QuickEntryIcon = styled.div`
  width: 46px;
  height: 46px;
  min-width: 46px;
  border-radius: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, rgba(255, 235, 239, 0.98), rgba(255, 245, 228, 0.98));
  color: #e25d74;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.86);
`

const QuickEntryImage = styled.img`
  width: 22px;
  height: 22px;
  object-fit: contain;
`

const QuickEntryBody = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
`

const QuickEntryTitle = styled.div`
  font-size: 15px;
  font-weight: 600;
  color: #303642;
`

const QuickEntryDescription = styled.div`
  margin-top: 5px;
  font-size: 12px;
  line-height: 1.55;
  color: #7f8896;
`

const EnvironmentGateCard = styled.div`
  width: min(460px, calc(100vw - 48px));
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 30px 28px;
  border-radius: 26px;
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.76);
  box-shadow:
    0 22px 56px rgba(15, 23, 42, 0.08),
    0 1px 0 rgba(255, 255, 255, 0.9) inset;
  text-align: center;
`

const EnvironmentGateIcon = styled.div`
  width: 52px;
  height: 52px;
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #e25d74;
  background: linear-gradient(135deg, rgba(255, 235, 239, 0.95), rgba(255, 245, 228, 0.95));
`

const EnvironmentGateTitle = styled.div`
  margin-top: 18px;
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text-1);
`

const EnvironmentGateDescription = styled.div`
  margin-top: 10px;
  max-width: 360px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--color-text-2);
`

const EnvironmentGateHint = styled.div`
  margin-top: 8px;
  max-width: 420px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-3);
`

const EnvironmentGateError = styled.div`
  margin-top: 14px;
  max-width: 360px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-error);
  word-break: break-word;
`

const EnvironmentDependencyList = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 16px;
`

const EnvironmentDependencyPill = styled.span`
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(226, 93, 116, 0.09);
  color: #d9485f;
  font-size: 12px;
  font-weight: 500;
`

const EnvironmentGateActions = styled.div`
  display: flex;
  gap: 10px;
  margin-top: 22px;
`

const Container = ({ children, className }: PropsWithChildren<{ className?: string }>) => {
  const { isTopNavbar } = useNavbarPosition()

  return (
    <div
      className={cn(
        'flex flex-1 overflow-hidden',
        isTopNavbar && 'rounded-tl-[10px] rounded-bl-[10px] bg-(--color-background)',
        className
      )}>
      {children}
    </div>
  )
}

export default AgentChat
