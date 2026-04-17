import AddAssistantPopup from '@renderer/components/Popups/AddAssistantPopup'
import { useAssistants, useDefaultAssistant } from '@renderer/hooks/useAssistant'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import { useShowTopics } from '@renderer/hooks/useStore'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { Assistant, Topic } from '@renderer/types'
import type { Tab } from '@renderer/types/chat'
import { classNames, uuid } from '@renderer/utils'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import Assistants from './AssistantsTab'
import ConversationHistoryList from './components/ConversationHistoryList'
import Topics from './TopicsTab'

interface Props {
  activeAssistant: Assistant
  activeTopic: Topic
  setActiveAssistant: (assistant: Assistant) => void
  setActiveTopic: (topic: Topic) => void
  position: 'left' | 'right'
  forceToSeeAllTab?: boolean
  mode?: 'default' | 'conversations-only' | 'topics-only'
  onOpenTopics?: () => void
  onCreateConversation?: () => void
  style?: React.CSSProperties
}

let _tab: Tab | null = null

const HomeTabs: FC<Props> = ({
  activeAssistant,
  activeTopic,
  setActiveAssistant,
  setActiveTopic,
  position,
  forceToSeeAllTab,
  mode = 'default',
  onCreateConversation,
  style
}) => {
  const { addAssistant } = useAssistants()
  const { topicPosition } = useSettings()
  const { defaultAssistant } = useDefaultAssistant()
  const { toggleShowTopics } = useShowTopics()
  const { isLeftNavbar } = useNavbarPosition()
  const { t } = useTranslation()

  const [tab, setTab] = useState<Tab>(
    mode === 'topics-only' ? 'topic' : position === 'left' ? _tab || 'assistants' : 'topic'
  )
  const borderStyle = '0.5px solid var(--color-border)'
  const border = mode === 'conversations-only'
    ? {}
    : (
    position === 'left'
      ? { borderRight: isLeftNavbar ? borderStyle : 'none' }
      : { borderLeft: isLeftNavbar ? borderStyle : 'none', borderTopLeftRadius: 0 }
      )

  if (mode === 'default' && position === 'left' && topicPosition === 'left') {
    _tab = tab
  }

  const showTab = mode === 'default' && position === 'left' && topicPosition === 'left'

  const onCreateAssistant = async () => {
    const assistant = await AddAssistantPopup.show()
    if (assistant) {
      setActiveAssistant(assistant)
    }
  }

  const onCreateDefaultAssistant = () => {
    const assistant = { ...defaultAssistant, id: uuid() }
    addAssistant(assistant)
    setActiveAssistant(assistant)
  }

  useEffect(() => {
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.SHOW_ASSISTANTS, (): any => {
        showTab && setTab('assistants')
      }),
      EventEmitter.on(EVENT_NAMES.SHOW_TOPIC_SIDEBAR, (): any => {
        showTab && setTab('topic')
      }),
      EventEmitter.on(EVENT_NAMES.SWITCH_TOPIC_SIDEBAR, () => {
        showTab && setTab('topic')
        if (position === 'left' && topicPosition === 'right') {
          toggleShowTopics()
        }
      })
    ]
    return () => unsubscribes.forEach((unsub) => unsub())
  }, [position, setTab, showTab, tab, toggleShowTopics, topicPosition])

  useEffect(() => {
    if (position === 'right' && topicPosition === 'right' && tab === 'assistants') {
      setTab('topic')
    }
    if (position === 'left' && topicPosition === 'right' && tab === 'topic') {
      setTab('assistants')
    }
  }, [position, tab, topicPosition, forceToSeeAllTab])

  return (
    <Container
      $isConversationOnly={mode === 'conversations-only'}
      style={{ ...border, ...style }}
      className={classNames('home-tabs', { right: position === 'right' && topicPosition === 'right' })}>
      {mode === 'conversations-only' && (
        <PanelHeader>
          <PanelTitle>对话记录</PanelTitle>
        </PanelHeader>
      )}

      {mode === 'topics-only' && (
        <PanelHeader>
          <PanelTitle>{t('common.topics')}</PanelTitle>
        </PanelHeader>
      )}

      {mode === 'default' && position === 'left' && topicPosition === 'left' && (
        <CustomTabs>
          <TabItem active={tab === 'assistants'} onClick={() => setTab('assistants')}>
            {t('assistants.abbr')}
          </TabItem>
          <TabItem active={tab === 'topic'} onClick={() => setTab('topic')}>
            {t('common.topics')}
          </TabItem>
        </CustomTabs>
      )}

      <TabContent className="home-tabs-content">
        {(mode === 'conversations-only' || tab === 'assistants') && mode !== 'topics-only' && (
          mode === 'conversations-only' ? (
            <ConversationHistoryList
              activeTopic={activeTopic}
              setActiveTopic={setActiveTopic}
              onCreateConversation={onCreateConversation || onCreateDefaultAssistant}
            />
          ) : (
            <Assistants
              activeAssistant={activeAssistant}
              setActiveAssistant={setActiveAssistant}
              onCreateAssistant={onCreateAssistant}
              onCreateDefaultAssistant={onCreateDefaultAssistant}
            />
          )
        )}
        {(mode === 'topics-only' || tab === 'topic') && mode !== 'conversations-only' && (
          <Topics
            assistant={activeAssistant}
            activeTopic={activeTopic}
            setActiveTopic={setActiveTopic}
            position={position}
          />
        )}
      </TabContent>
    </Container>
  )
}

const Container = styled.div<{ $isConversationOnly: boolean }>`
  display: flex;
  flex-direction: column;
  width: var(--assistants-width);
  transition: width 0.3s;
  height: calc(100vh - var(--navbar-height));
  position: relative;
  background: #ffffff;
  box-shadow: -8px 0 24px rgba(15, 23, 42, 0.025);

  &.right {
    height: calc(100vh - var(--navbar-height));
  }

  [navbar-position='left'] & {
    background-color: #ffffff;
  }
  [navbar-position='top'] & {
    height: calc(100vh - var(--navbar-height));
  }
  overflow: hidden;
  .collapsed {
    width: 0;
    border-left: none;
  }
`

const TabContent = styled.div`
  display: flex;
  transition: width 0.3s;
  flex: 1;
  flex-direction: column;
  overflow-y: hidden;
  overflow-x: hidden;
`

const CustomTabs = styled.div`
  display: flex;
  margin: 0 12px;
  padding: 6px 0;
  background: transparent;
  -webkit-app-region: no-drag;
  [navbar-position='top'] & {
    padding-top: 2px;
  }
`

const PanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 12px;
  padding: 10px 0 8px;
  -webkit-app-region: no-drag;
`

const PanelTitle = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: #1f2329;
`

const TabItem = styled.button<{ active: boolean }>`
  flex: 1;
  height: 30px;
  border: none;
  background: transparent;
  color: ${(props) => (props.active ? 'var(--color-text)' : 'var(--color-text-secondary)')};
  font-size: 13px;
  font-weight: ${(props) => (props.active ? '600' : '400')};
  cursor: pointer;
  border-radius: 8px;
  margin: 0 2px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;

  &:hover {
    color: var(--color-text);
  }

  &:active {
    transform: scale(0.98);
  }

  &::after {
    content: '';
    position: absolute;
    bottom: -8px;
    left: 50%;
    transform: translateX(-50%);
    width: ${(props) => (props.active ? '30px' : '0')};
    height: 3px;
    background: var(--color-primary);
    border-radius: 1px;
    transition: all 0.2s ease;
  }

  &:hover::after {
    width: ${(props) => (props.active ? '30px' : '16px')};
    background: ${(props) => (props.active ? 'var(--color-primary)' : 'var(--color-primary-soft)')};
  }
`

export default HomeTabs
