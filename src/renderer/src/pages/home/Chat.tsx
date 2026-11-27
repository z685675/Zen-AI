import { loggerService } from '@logger'
import ModelStatusPills from '@renderer/components/app/ModelStatusPills'
import type { ContentSearchRef } from '@renderer/components/ContentSearch'
import { ContentSearch } from '@renderer/components/ContentSearch'
import ModelSetupGuide from '@renderer/components/ModelSetupGuide'
import MultiSelectActionPopup from '@renderer/components/Popups/MultiSelectionPopup'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup'
import { QuickPanelProvider } from '@renderer/components/QuickPanel'
import { chatModelFilter } from '@renderer/config/models'
import { useSidebarActiveModel } from '@renderer/context/SidebarSlotProvider'
import { useAssistant, useDefaultModel } from '@renderer/hooks/useAssistant'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTimer } from '@renderer/hooks/useTimer'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { modelRecoveryIntents } from '@renderer/services/modelRecoveryIntents'
import { useAppSelector } from '@renderer/store'
import type { Assistant, Topic } from '@renderer/types'
import { classNames } from '@renderer/utils'
import {
  consumeLocallyVerifiedEmptyConversation,
  isLocallyVerifiedEmptyConversation
} from '@renderer/utils/conversationDraft'
import { getTopicConversationModel, shouldPersistConversationModelAsDefault } from '@renderer/utils/conversationModel'
import { getAvailableChatModels } from '@renderer/utils/modelAvailability'
import { Flex } from 'antd'
import { debounce } from 'lodash'
import type { FC } from 'react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import AssistantSwitchButton from './components/AssistantSwitchButton'
import ChatNavbar from './components/ChatNavBar'
import Tools from './components/ChatNavBar/Tools'
import QuickAssistantDeck from './components/QuickAssistantDeck'
import SelectModelButton from './components/SelectModelButton'
import type { ProviderActionHandlers } from './Inputbar/Inputbar'
import Inputbar from './Inputbar/Inputbar'
import ChatNavigation from './Messages/ChatNavigation'
import Messages from './Messages/Messages'

const logger = loggerService.withContext('Chat')

interface Props {
  assistants: Assistant[]
  assistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  setActiveAssistant: (assistant: Assistant) => void
  onCreateConversation: () => Promise<void>
}

const Chat: FC<Props> = ({
  assistants,
  assistant: activeAssistant,
  activeTopic,
  setActiveTopic,
  setActiveAssistant,
  onCreateConversation
}) => {
  const { assistant: storedAssistant, updateTopic } = useAssistant(activeAssistant.id)
  const { setDefaultModel } = useDefaultModel()
  const { t } = useTranslation()
  const { messageStyle, messageNavigation } = useSettings()
  const quickAssistantIds = useAppSelector((state) => state.assistants.quickAssistantIds ?? [])
  const { isMultiSelectMode } = useChatContext(activeTopic)
  const messages = useTopicMessages(activeTopic.id)
  const hasLoadedTopicMessages = useAppSelector((state) => !!state.messages.loadedByTopic[activeTopic.id])
  const isLoadingTopicMessages = useAppSelector((state) => !!state.messages.loadingByTopic[activeTopic.id])
  const providers = useAppSelector((state) => state.llm.providers)
  const hasAvailableChatModels = useMemo(() => getAvailableChatModels(providers).length > 0, [providers])
  const isBlankConversation = shouldPersistConversationModelAsDefault(hasLoadedTopicMessages, messages.length)
  // Only render the welcome screen for topics known to be empty (either newly
  // created/verified empty drafts or topics whose messages finished loading with
  // 0 items). Unloaded historical topics stay in the active chat shell while
  // IndexedDB loads so switching history never flashes the welcome screen.
  const isKnownEmptyDraft = isLocallyVerifiedEmptyConversation(activeTopic.id)
  const isWelcomeState =
    messages.length === 0 && (isKnownEmptyDraft || (hasLoadedTopicMessages && !isLoadingTopicMessages))

  useEffect(() => {
    if (messages.length > 0 && isLocallyVerifiedEmptyConversation(activeTopic.id)) {
      consumeLocallyVerifiedEmptyConversation(activeTopic.id)
    }
  }, [activeTopic.id, messages.length])
  const assistant = useMemo(
    () => ({ ...storedAssistant, model: getTopicConversationModel(activeTopic, storedAssistant) }),
    [activeTopic, storedAssistant]
  )

  const selectableAssistants = useMemo(() => {
    const defaultAssistant = assistants.find((item) => item.id === 'default') || assistants[0]
    const visibleIds = new Set<string>()
    const visibleAssistants: Assistant[] = []

    if (defaultAssistant?.id) {
      visibleIds.add(defaultAssistant.id)
      visibleAssistants.push(defaultAssistant)
    }

    for (const assistantId of quickAssistantIds) {
      const matchedAssistant = assistants.find((item) => item.id === assistantId)
      if (!matchedAssistant || visibleIds.has(matchedAssistant.id)) {
        continue
      }

      visibleIds.add(matchedAssistant.id)
      visibleAssistants.push(matchedAssistant)
    }

    if (assistant?.id && !visibleIds.has(assistant.id)) {
      visibleAssistants.push(assistant)
    }

    return visibleAssistants
  }, [assistant, assistants, quickAssistantIds])

  const mainRef = React.useRef<HTMLDivElement>(null)
  const contentSearchRef = React.useRef<ContentSearchRef>(null)
  const floatingDockRef = useRef<HTMLDivElement>(null)
  const [composerInset, setComposerInset] = useState(152)

  useEffect(() => {
    const dock = floatingDockRef.current
    if (!dock || isWelcomeState) return
    const update = () => {
      const next = Math.max(128, Math.round(dock.getBoundingClientRect().height + 14))
      setComposerInset((prev) => (Math.abs(prev - next) > 2 ? next : prev))
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(dock)
    return () => observer.disconnect()
  }, [isWelcomeState])
  const welcomeInputActionsRef = useRef<ProviderActionHandlers>({
    resizeTextArea: () => {},
    addNewTopic: () => {},
    clearTopic: () => {},
    onNewContext: () => {},
    onTextChange: () => {},
    toggleExpanded: () => {}
  })
  const [filterIncludeUser, setFilterIncludeUser] = useState(false)
  const { setTimeoutTimer } = useTimer()

  useHotkeys('esc', () => {
    contentSearchRef.current?.disable()
  })

  useShortcut('search_message_in_chat', () => {
    try {
      const selectedText = window.getSelection()?.toString().trim()
      contentSearchRef.current?.enable(selectedText)
    } catch (error) {
      logger.error('Error enabling content search:', error as Error)
    }
  })

  useShortcut('rename_topic', async () => {
    if (!activeTopic) return

    void EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)

    const name = await PromptPopup.show({
      title: t('chat.topics.edit.title'),
      message: '',
      defaultValue: activeTopic.name || '',
      extraNode: <div style={{ color: 'var(--color-text-3)', marginTop: 8 }}>{t('chat.topics.edit.title_tip')}</div>
    })

    if (name && activeTopic.name !== name) {
      const updatedTopic = { ...activeTopic, name, isNameManuallyEdited: true }
      updateTopic(updatedTopic as Topic)
    }
  })

  useShortcut('select_model', async () => {
    const selectedModel = await SelectChatModelPopup.show({
      model: assistant?.model,
      filter: chatModelFilter
    })

    if (selectedModel) {
      modelRecoveryIntents.set(`topic:${activeTopic.id}`, undefined)
      const nextTopic = { ...activeTopic, model: selectedModel }
      updateTopic(nextTopic)
      setActiveTopic(nextTopic)
      if (isBlankConversation) {
        setDefaultModel(selectedModel)
      }
    }
  })

  const contentSearchFilter: NodeFilter = {
    acceptNode(node) {
      const container = node.parentElement?.closest('.message-content-container')
      if (!container) return NodeFilter.FILTER_REJECT

      const message = container.closest('.message')
      if (!message) return NodeFilter.FILTER_REJECT

      if (filterIncludeUser) {
        return NodeFilter.FILTER_ACCEPT
      }

      if (message.classList.contains('message-assistant')) {
        return NodeFilter.FILTER_ACCEPT
      }

      return NodeFilter.FILTER_REJECT
    }
  }

  const userOutlinedItemClickHandler = () => {
    setFilterIncludeUser(!filterIncludeUser)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeoutTimer(
          'userOutlinedItemClickHandler',
          () => {
            contentSearchRef.current?.search()
            contentSearchRef.current?.focus()
          },
          0
        )
      })
    })
  }

  const firstUpdateCompletedRef = useRef(false)
  const firstUpdateOrNoFirstUpdateHandler = useMemo(
    () =>
      debounce(() => {
        contentSearchRef.current?.silentSearch()
      }, 10),
    []
  )

  useEffect(() => {
    return () => firstUpdateOrNoFirstUpdateHandler.cancel()
  }, [firstUpdateOrNoFirstUpdateHandler])

  const messagesComponentUpdateHandler = useCallback(() => {
    if (firstUpdateCompletedRef.current) {
      firstUpdateOrNoFirstUpdateHandler()
    }
  }, [firstUpdateOrNoFirstUpdateHandler])

  const messagesComponentFirstUpdateHandler = useCallback(() => {
    setTimeoutTimer(
      'messagesComponentFirstUpdateHandler',
      () => {
        firstUpdateCompletedRef.current = true
      },
      300
    )
    firstUpdateOrNoFirstUpdateHandler()
  }, [firstUpdateOrNoFirstUpdateHandler, setTimeoutTimer])

  const currentConversationModel = useMemo(
    () => getTopicConversationModel(activeTopic, storedAssistant),
    [activeTopic, storedAssistant]
  )
  useSidebarActiveModel(
    currentConversationModel
      ? {
          id: currentConversationModel.id,
          name: currentConversationModel.name,
          provider: currentConversationModel.provider
        }
      : undefined
  )

  return (
    <Container id="chat" className={classNames([messageStyle, { 'multi-select-mode': isMultiSelectMode }])}>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <Main
          ref={mainRef}
          id="chat-main"
          vertical
          flex={1}
          justify="space-between"
          style={{ height: '100%', width: '100%', minHeight: 0, overflow: 'hidden' }}>
          <QuickPanelProvider>
            <ChatNavbar />
            {isWelcomeState ? (
              <WelcomeState className="zen-view-enter">
                {hasAvailableChatModels ? (
                  <WelcomeInner>
                    <WelcomeTitle>{t('app_shell.chat_welcome')}</WelcomeTitle>
                    <WelcomeSubtitle>{t('app_shell.chat_welcome_subtitle')}</WelcomeSubtitle>
                    <WelcomeSelectors>
                      <AssistantSwitchButton
                        assistant={assistant}
                        assistants={selectableAssistants}
                        onSelectAssistant={setActiveAssistant}
                      />
                      <SelectModelButton
                        assistant={assistant}
                        topic={activeTopic}
                        onTopicChange={setActiveTopic}
                        persistAsDefault={isBlankConversation}
                      />
                      <ModelStatusPills
                        activeModel={
                          currentConversationModel
                            ? {
                                id: currentConversationModel.id,
                                name: currentConversationModel.name,
                                provider: currentConversationModel.provider
                              }
                            : undefined
                        }
                      />
                    </WelcomeSelectors>
                    <WelcomeComposer>
                      <Inputbar
                        assistant={assistant}
                        topic={activeTopic}
                        onTopicChange={setActiveTopic}
                        variant="hero"
                        actionsRef={welcomeInputActionsRef}
                        onCreateConversation={onCreateConversation}
                      />
                    </WelcomeComposer>
                    <QuickAssistantDeck
                      assistants={assistants}
                      activeAssistant={assistant}
                      onSelectAssistant={setActiveAssistant}
                    />
                  </WelcomeInner>
                ) : (
                  <ModelSetupGuide />
                )}
              </WelcomeState>
            ) : (
              <div
                className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
                style={{ '--zen-composer-inset': `${composerInset}px` } as React.CSSProperties}>
                <WorkspaceTopBar>
                  <WorkspaceSelectors>
                    <AssistantSwitchButton
                      assistant={assistant}
                      assistants={selectableAssistants}
                      onSelectAssistant={setActiveAssistant}
                    />
                    <SelectModelButton
                      assistant={assistant}
                      topic={activeTopic}
                      onTopicChange={setActiveTopic}
                      persistAsDefault={isBlankConversation}
                    />
                    <ModelStatusPills
                      activeModel={
                        currentConversationModel
                          ? {
                              id: currentConversationModel.id,
                              name: currentConversationModel.name,
                              provider: currentConversationModel.provider
                            }
                          : undefined
                      }
                    />
                  </WorkspaceSelectors>
                  <WorkspaceToolsSlot>
                    <Tools assistant={assistant} />
                  </WorkspaceToolsSlot>
                </WorkspaceTopBar>
                <div
                  key={activeTopic.id}
                  className={classNames(
                    'flex min-h-0 flex-1 flex-col overflow-hidden',
                    hasLoadedTopicMessages || messages.length > 0 ? 'zen-content-enter' : 'opacity-0'
                  )}>
                  <Messages
                    assistant={assistant}
                    topic={activeTopic}
                    setActiveTopic={setActiveTopic}
                    onComponentUpdate={messagesComponentUpdateHandler}
                    onFirstUpdate={messagesComponentFirstUpdateHandler}
                  />
                </div>
                <ContentSearch
                  ref={contentSearchRef}
                  searchTarget={mainRef as React.RefObject<HTMLElement>}
                  filter={contentSearchFilter}
                  includeUser={filterIncludeUser}
                  onIncludeUserChange={userOutlinedItemClickHandler}
                />
                {messageNavigation === 'buttons' && <ChatNavigation containerId="messages" />}
                <FloatingComposerDock ref={floatingDockRef}>
                  <FloatingComposerInner>
                    {!hasAvailableChatModels && <ModelSetupGuide compact />}
                    <Inputbar
                      assistant={assistant}
                      topic={activeTopic}
                      onTopicChange={setActiveTopic}
                      onCreateConversation={onCreateConversation}
                    />
                    {isMultiSelectMode && <MultiSelectActionPopup topic={activeTopic} />}
                  </FloatingComposerInner>
                </FloatingComposerDock>
              </div>
            )}
          </QuickPanelProvider>
        </Main>
      </div>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: transparent;
`

const Main = styled(Flex)`
  position: relative;
  min-height: 0;
  overflow: hidden;
`

const WorkspaceTopBar = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 24px 18px;
  background: var(--zen-veil-top);
  pointer-events: none;
`

const WorkspaceSelectors = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
  pointer-events: auto;
`

const WorkspaceToolsSlot = styled.div`
  display: flex;
  align-items: center;
  pointer-events: auto;
`

const FloatingComposerDock = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  padding-top: 22px;
  background: var(--zen-veil-bottom);
  pointer-events: none;
`

const FloatingComposerInner = styled.div`
  pointer-events: auto;
`

const WelcomeSelectors = styled.div`
  width: calc(100% + 64px);
  max-width: var(--zen-composer-width);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 22px;
`

const WelcomeState = styled.div`
  display: flex;
  flex: 1;
  min-height: 0;
  justify-content: center;
  padding: 48px 36px 56px;
  position: relative;
  overflow-x: hidden;
  overflow-y: auto;
`

const WelcomeInner = styled.div`
  width: 100%;
  max-width: 760px;
  margin: auto 0;
  display: flex;
  flex-direction: column;
  align-items: center;
`

const WelcomeTitle = styled.h1`
  margin: 0;
  font-size: 28px;
  line-height: 1.25;
  font-weight: 500;
  color: var(--zen-text-1);
  text-align: center;
  letter-spacing: -0.025em;
`

const WelcomeSubtitle = styled.p`
  margin: 8px 0 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--zen-text-3);
  text-align: center;
`

const WelcomeComposer = styled.div`
  width: calc(100% + 64px);
  margin-inline: -32px;
  margin-top: 18px;
`

export default Chat
