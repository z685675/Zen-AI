import EmojiIcon from '@renderer/components/EmojiIcon'
import { QuickPanelProvider } from '@renderer/components/QuickPanel'
import { useActiveAgent } from '@renderer/hooks/agents/useActiveAgent'
import { useAgents } from '@renderer/hooks/agents/useAgents'
import { useCreateDefaultSession } from '@renderer/hooks/agents/useCreateDefaultSession'
import { useSession } from '@renderer/hooks/agents/useSession'
import { useUpdateSession } from '@renderer/hooks/agents/useUpdateSession'
import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import { cn } from '@renderer/utils'
import { buildAgentSessionTopicId, getChannelTypeIcon } from '@renderer/utils/agentSession'
import { DEFAULT_FUSION_AGENT_ID, getAgentAvatar } from '@shared/config/agents'
import { Alert, Spin } from 'antd'
import { FolderOpen, ListTodo, ScrollText, Search, Sparkles } from 'lucide-react'
import type { PropsWithChildren, ReactNode } from 'react'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { PinnedTodoPanel } from '../home/Inputbar/components/PinnedTodoPanel'
import ChatNavigation from '../home/Messages/ChatNavigation'
import NarrowLayout from '../home/Messages/NarrowLayout'
import AgentChatNavbar from './components/AgentChatNavbar'
import AgentSessionInputbar from './components/AgentSessionInputbar'
import AgentSessionMessages from './components/AgentSessionMessages'
import AgentTaskStatusBar from './components/AgentTaskStatusBar'

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

const AgentChat = () => {
  const { t } = useTranslation()
  const { messageNavigation, messageStyle } = useSettings()
  const dispatch = useAppDispatch()
  const { chat } = useRuntime()
  const { activeAgentId, activeSessionIdMap, isMultiSelectMode } = chat
  const activeSessionId = activeAgentId ? activeSessionIdMap[activeAgentId] : null
  const isSessionInitialized = !activeAgentId || activeAgentId in activeSessionIdMap
  const { agent: activeAgent, isLoading: isAgentLoading } = useActiveAgent()
  const { isLoading: isAgentsLoading, agents } = useAgents()
  const { createDefaultSession } = useCreateDefaultSession(activeAgentId)
  useSession(activeAgentId, activeSessionId)
  useUpdateSession(activeAgentId)
  const sessionTopicId = activeSessionId ? buildAgentSessionTopicId(activeSessionId) : ''
  const messages = useTopicMessages(sessionTopicId)
  const hasLoadedSessionMessages = useAppSelector((state) =>
    sessionTopicId ? !!state.messages.loadedByTopic[sessionTopicId] : false
  )
  const isWelcomeState = hasLoadedSessionMessages && messages.length === 0
  const isSessionMessagesBootstrapping = !!activeSessionId && !!sessionTopicId && !hasLoadedSessionMessages

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
      }
    ],
    []
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
      enabled: true,
      preventDefault: true,
      enableOnFormTags: true
    }
  )

  const isInitializing =
    isAgentsLoading || isAgentLoading || !isSessionInitialized || !agents || (!activeAgentId && agents.length > 0)
  const brandAvatar = getAgentAvatar(DEFAULT_FUSION_AGENT_ID)

  if (isInitializing) {
    return (
      <Container className="flex flex-1 flex-col items-center justify-center">
        <Spin />
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
  grid-template-columns: minmax(260px, 360px);
  gap: 14px;

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
