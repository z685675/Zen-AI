import { loggerService } from '@logger'
import type { ContentSearchRef } from '@renderer/components/ContentSearch'
import { ContentSearch } from '@renderer/components/ContentSearch'
import { HStack } from '@renderer/components/Layout'
import MultiSelectActionPopup from '@renderer/components/Popups/MultiSelectionPopup'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup'
import { QuickPanelProvider } from '@renderer/components/QuickPanel'
import { isEmbeddingModel, isRerankModel, isWebSearchModel } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowTopics } from '@renderer/hooks/useStore'
import { useTimer } from '@renderer/hooks/useTimer'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { Assistant, Model, Topic } from '@renderer/types'
import { classNames } from '@renderer/utils'
import { Flex } from 'antd'
import { debounce } from 'lodash'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import React, { useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import AssistantSwitchButton from './components/AssistantSwitchButton'
import ChatNavbar from './components/ChatNavBar'
import QuickAssistantDeck from './components/QuickAssistantDeck'
import SelectModelButton from './components/SelectModelButton'
import type { ProviderActionHandlers } from './Inputbar/Inputbar'
import Inputbar from './Inputbar/Inputbar'
import ChatNavigation from './Messages/ChatNavigation'
import Messages from './Messages/Messages'
import Tabs from './Tabs'

const logger = loggerService.withContext('Chat')

interface Props {
  assistants: Assistant[]
  assistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  setActiveAssistant: (assistant: Assistant) => void
}

const Chat: FC<Props> = ({ assistants, assistant: activeAssistant, activeTopic, setActiveTopic, setActiveAssistant }) => {
  const { assistant, updateAssistant, updateTopic } = useAssistant(activeAssistant.id)
  const { t } = useTranslation()
  const { topicPosition, messageStyle, messageNavigation } = useSettings()
  const { showTopics } = useShowTopics()
  const { isMultiSelectMode } = useChatContext(activeTopic)
  const { isTopNavbar } = useNavbarPosition()
  const messages = useTopicMessages(activeTopic.id)
  const isWelcomeState = messages.length === 0

  const mainRef = React.useRef<HTMLDivElement>(null)
  const contentSearchRef = React.useRef<ContentSearchRef>(null)
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
    const modelFilter = (item: Model) => !isEmbeddingModel(item) && !isRerankModel(item)
    const selectedModel = await SelectChatModelPopup.show({
      model: assistant?.model,
      filter: modelFilter
    })

    if (selectedModel) {
      const enabledWebSearch = isWebSearchModel(selectedModel)
      updateAssistant({
        model: selectedModel,
        enableWebSearch: enabledWebSearch && assistant.enableWebSearch
      })
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

  let firstUpdateCompleted = false
  const firstUpdateOrNoFirstUpdateHandler = debounce(() => {
    contentSearchRef.current?.silentSearch()
  }, 10)

  const messagesComponentUpdateHandler = () => {
    if (firstUpdateCompleted) {
      firstUpdateOrNoFirstUpdateHandler()
    }
  }

  const messagesComponentFirstUpdateHandler = () => {
    setTimeoutTimer('messagesComponentFirstUpdateHandler', () => (firstUpdateCompleted = true), 300)
    firstUpdateOrNoFirstUpdateHandler()
  }

  const mainHeight = isTopNavbar ? 'calc(100vh - var(--navbar-height) - 6px)' : 'calc(100vh - var(--navbar-height))'

  return (
    <Container id="chat" className={classNames([messageStyle, { 'multi-select-mode': isMultiSelectMode }])}>
      <HStack>
        <motion.div
          layout
          transition={{ duration: 0.3, ease: 'easeInOut' }}
          style={{ flex: 1, display: 'flex', minWidth: 0, overflow: 'hidden' }}>
          <Main
            ref={mainRef}
            id="chat-main"
            vertical
            flex={1}
            justify="space-between"
            style={{ height: mainHeight, width: '100%' }}>
            <QuickPanelProvider>
              {!isWelcomeState && (
                <ChatNavbar
                  assistants={assistants}
                  activeAssistant={activeAssistant}
                  activeTopic={activeTopic}
                  setActiveTopic={setActiveTopic}
                  setActiveAssistant={setActiveAssistant}
                  position="left"
                />
              )}
              {isWelcomeState ? (
                <WelcomeState>
                  <WelcomeInner>
                    <WelcomeTitle>从一次更轻松的对话开始</WelcomeTitle>
                    <WelcomeDescription>
                      直接输入问题会使用默认助手。也可以先在下面选一个角色，让这一轮对话从一开始就带着明确风格。
                    </WelcomeDescription>
                    <WelcomeMeta>
                      <AssistantSwitchButton
                        assistant={assistant}
                        assistants={assistants}
                        onSelectAssistant={setActiveAssistant}
                      />
                      <SelectModelButton assistant={assistant} />
                    </WelcomeMeta>
                    <WelcomeComposer>
                      <Inputbar
                        assistant={assistant}
                        setActiveTopic={setActiveTopic}
                        topic={activeTopic}
                        variant="hero"
                        actionsRef={welcomeInputActionsRef}
                      />
                    </WelcomeComposer>
                    <QuickAssistantDeck
                      assistants={assistants}
                      activeAssistant={assistant}
                      onSelectAssistant={setActiveAssistant}
                    />
                  </WelcomeInner>
                </WelcomeState>
              ) : (
                <div
                  className="flex flex-1 flex-col justify-between"
                  style={{ height: `calc(${mainHeight} - var(--navbar-height))` }}>
                  <Messages
                    key={activeTopic.id}
                    assistant={assistant}
                    topic={activeTopic}
                    setActiveTopic={setActiveTopic}
                    onComponentUpdate={messagesComponentUpdateHandler}
                    onFirstUpdate={messagesComponentFirstUpdateHandler}
                  />
                  <ContentSearch
                    ref={contentSearchRef}
                    searchTarget={mainRef as React.RefObject<HTMLElement>}
                    filter={contentSearchFilter}
                    includeUser={filterIncludeUser}
                    onIncludeUserChange={userOutlinedItemClickHandler}
                  />
                  {messageNavigation === 'buttons' && <ChatNavigation containerId="messages" />}
                  <Inputbar assistant={assistant} setActiveTopic={setActiveTopic} topic={activeTopic} />
                  {isMultiSelectMode && <MultiSelectActionPopup topic={activeTopic} />}
                </div>
              )}
            </QuickPanelProvider>
          </Main>
        </motion.div>
        <AnimatePresence initial={false}>
          {topicPosition === 'right' && showTopics && (
            <motion.div
              key="right-tabs"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 'var(--assistants-width)', opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              style={{ overflow: 'hidden' }}>
              <Tabs
                activeAssistant={assistant}
                activeTopic={activeTopic}
                setActiveAssistant={setActiveAssistant}
                setActiveTopic={setActiveTopic}
                position="right"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </HStack>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--navbar-height));
  flex: 1;
  overflow: hidden;
  background: #ffffff;

  [navbar-position='top'] & {
    height: calc(100vh - var(--navbar-height) - 6px);
    background-color: #ffffff;
    border-top-left-radius: 10px;
    border-bottom-left-radius: 10px;
  }
`

const Main = styled(Flex)`
  [navbar-position='left'] & {
    height: calc(100vh - var(--navbar-height));
  }

  transform: translateZ(0);
  position: relative;
`

const WelcomeState = styled.div`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 40px 26px 30px;
`

const WelcomeInner = styled.div`
  width: 100%;
  max-width: 1140px;
  display: flex;
  flex-direction: column;
  align-items: center;
`

const WelcomeMeta = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  flex-wrap: wrap;
  justify-content: center;
`

const WelcomeTitle = styled.h1`
  margin: 0;
  font-size: 26px;
  line-height: 1.2;
  font-weight: 500;
  color: #333333;
  text-align: center;
  letter-spacing: -0.02em;
`

const WelcomeDescription = styled.p`
  margin: 12px 0 0;
  max-width: 720px;
  font-size: 13px;
  line-height: 1.7;
  color: #8f959e;
  text-align: center;
`

const WelcomeComposer = styled.div`
  width: 100%;
  max-width: 1100px;
  margin-top: 10px;
`

export default Chat
