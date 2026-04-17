import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import db from '@renderer/databases'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants, useShowTopics } from '@renderer/hooks/useStore'
import { useActiveTopic } from '@renderer/hooks/useTopic'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import NavigationService from '@renderer/services/NavigationService'
import { addTopic as addTopicAction, removeTopic as removeTopicAction } from '@renderer/store/assistants'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Assistant, Topic } from '@renderer/types'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, SECOND_MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import { startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import { useDispatch } from 'react-redux'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import Chat from './Chat'
import TopicsDrawer from './components/TopicsDrawer'
import Navbar from './Navbar'
import HomeTabs from './Tabs'

let _activeAssistant: Assistant

const HomePage: FC = () => {
  const { assistants } = useAssistants()
  const navigate = useNavigate()
  const { isLeftNavbar } = useNavbarPosition()
  const location = useLocation()
  const state = location.state
  const dispatch = useDispatch()

  const { showAssistants, showTopics, topicPosition } = useSettings()
  const { setShowAssistants, toggleShowAssistants } = useShowAssistants()
  const { toggleShowTopics } = useShowTopics()

  const defaultConversationAssistant = useMemo(
    () => assistants.find((assistant) => assistant.id === 'default') || assistants[0],
    [assistants]
  )

  const [activeAssistant, _setActiveAssistant] = useState<Assistant>(
    state?.assistant || _activeAssistant || defaultConversationAssistant
  )
  const { activeTopic, setActiveTopic: _setActiveTopic } = useActiveTopic(activeAssistant?.id ?? '', state?.topic)

  _activeAssistant = activeAssistant

  const createTopicForAssistant = useCallback(
    async (assistant: Assistant) => {
      const topic = getDefaultTopic(assistant.id)
      await db.topics.add({ id: topic.id, messages: [] })
      dispatch(addTopicAction({ assistantId: assistant.id, topic }))
      return topic
    },
    [dispatch]
  )

  const getOrCreateEmptyTopicForAssistant = useCallback(
    async (assistant: Assistant) => {
      for (const topic of assistant.topics) {
        const dbTopic = await db.topics.get(topic.id)
        if ((dbTopic?.messages?.length || 0) === 0) {
          return topic
        }
      }

      return await createTopicForAssistant(assistant)
    },
    [createTopicForAssistant]
  )

  const setActiveAssistant = useCallback(
    async (newAssistant: Assistant) => {
      if (!newAssistant || newAssistant.id === activeAssistant?.id) return

      const nextTopic = newAssistant.topics[0] || (await getOrCreateEmptyTopicForAssistant(newAssistant))
      if (!nextTopic) return

      startTransition(() => {
        _setActiveAssistant(newAssistant)
        _setActiveTopic((prev) => (nextTopic.id === prev?.id ? prev : nextTopic))
      })
    },
    [_setActiveTopic, activeAssistant?.id, getOrCreateEmptyTopicForAssistant]
  )

  const setActiveTopic = useCallback(
    (newTopic: Topic) => {
      const topicAssistant = assistants.find((assistant) => assistant.id === newTopic.assistantId) || activeAssistant

      startTransition(() => {
        if (topicAssistant && topicAssistant.id !== activeAssistant?.id) {
          _setActiveAssistant(topicAssistant)
        }
        _setActiveTopic((prev) => (newTopic.id === prev?.id ? prev : newTopic))
        dispatch(newMessagesActions.setTopicFulfilled({ topicId: newTopic.id, fulfilled: false }))
      })
    },
    [_setActiveTopic, activeAssistant, assistants, dispatch]
  )

  const bindAssistantToActiveTopic = useCallback(
    async (targetAssistant: Assistant) => {
      if (!targetAssistant || !activeTopic) {
        return
      }

      const sourceAssistant = assistants.find((assistant) => assistant.id === activeTopic.assistantId) || activeAssistant

      if (!sourceAssistant) {
        return
      }

      if (sourceAssistant.id === targetAssistant.id) {
        startTransition(() => {
          _setActiveAssistant(targetAssistant)
        })
        return
      }

      const dbTopic = await db.topics.get(activeTopic.id)
      const isDraftTopic = (dbTopic?.messages?.length || 0) === 0

      const nextTopic: Topic = {
        ...activeTopic,
        assistantId: targetAssistant.id,
        updatedAt: new Date().toISOString()
      }

      dispatch(addTopicAction({ assistantId: targetAssistant.id, topic: nextTopic }))

      startTransition(() => {
        _setActiveAssistant(targetAssistant)
        _setActiveTopic(nextTopic)
      })

      dispatch(removeTopicAction({ assistantId: sourceAssistant.id, topic: activeTopic }))

      if (!isDraftTopic) {
        await db.topics
          .where('id')
          .equals(activeTopic.id)
          .modify((dbTopic) => {
            if (dbTopic.messages) {
              dbTopic.messages = dbTopic.messages.map((message) => ({
                ...message,
                assistantId: targetAssistant.id
              }))
            }
          })
      }
    },
    [_setActiveTopic, activeAssistant, activeTopic, assistants, dispatch]
  )

  const createConversation = useCallback(async () => {
    if (!defaultConversationAssistant) {
      return
    }

    const topic = await getOrCreateEmptyTopicForAssistant(defaultConversationAssistant)
    startTransition(() => {
      _setActiveAssistant(defaultConversationAssistant)
      _setActiveTopic(topic)
      dispatch(newMessagesActions.setTopicFulfilled({ topicId: topic.id, fulfilled: false }))
    })
  }, [_setActiveTopic, defaultConversationAssistant, dispatch, getOrCreateEmptyTopicForAssistant])

  useShortcut('toggle_show_assistants', () => {
    if (topicPosition === 'right') {
      toggleShowAssistants()
      return
    }

    if (!showAssistants) {
      setShowAssistants(true)
      requestAnimationFrame(() => {
        void EventEmitter.emit(EVENT_NAMES.SHOW_ASSISTANTS)
      })
      return
    }

    void EventEmitter.emit(EVENT_NAMES.SHOW_ASSISTANTS)
  })

  useShortcut('toggle_show_topics', () => {
    if (topicPosition === 'right') {
      toggleShowTopics()
      return
    }

    if (!showAssistants) {
      setShowAssistants(true)
      requestAnimationFrame(() => {
        void EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)
      })
      return
    }

    void EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)
  })

  useEffect(() => {
    NavigationService.setNavigate(navigate)
  }, [navigate])

  useEffect(() => {
    if (!activeAssistant && defaultConversationAssistant) {
      _setActiveAssistant(defaultConversationAssistant)
    }
  }, [activeAssistant, defaultConversationAssistant])

  useEffect(() => {
    if (activeTopic || !activeAssistant) {
      return
    }

    let cancelled = false

    const ensureDraftTopic = async () => {
      const draftTopic = await getOrCreateEmptyTopicForAssistant(activeAssistant)
      if (cancelled) {
        return
      }

      _setActiveTopic((prev) => prev ?? draftTopic)
    }

    void ensureDraftTopic()

    return () => {
      cancelled = true
    }
  }, [activeAssistant, activeTopic, _setActiveTopic, getOrCreateEmptyTopicForAssistant])

  useEffect(() => {
    const exists = assistants.some((assistant) => assistant.id === activeAssistant?.id)
    if (!exists && defaultConversationAssistant) {
      _setActiveAssistant(defaultConversationAssistant)
    }
  }, [activeAssistant?.id, assistants, defaultConversationAssistant])

  useEffect(() => {
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.SHOW_TOPIC_SIDEBAR, () => {
        if (!isLeftNavbar) return
        void TopicsDrawer.show({
          activeAssistant,
          setActiveAssistant,
          activeTopic,
          setActiveTopic
        })
      }),
      EventEmitter.on(EVENT_NAMES.SWITCH_TOPIC_SIDEBAR, () => {
        if (!isLeftNavbar) return
        void TopicsDrawer.show({
          activeAssistant,
          setActiveAssistant,
          activeTopic,
          setActiveTopic
        })
      })
    ]

    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [activeAssistant, activeTopic, isLeftNavbar, setActiveAssistant, setActiveTopic])

  useEffect(() => {
    state?.assistant && setActiveAssistant(state.assistant)
    state?.topic && setActiveTopic(state.topic)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  useEffect(() => {
    const canMinimize = topicPosition == 'left' ? !showAssistants : !showAssistants && !showTopics
    void window.api.window.setMinimumSize(canMinimize ? SECOND_MIN_WINDOW_WIDTH : MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)

    return () => {
      void window.api.window.resetMinimumSize()
    }
  }, [showAssistants, showTopics, topicPosition])

  return (
    <Container id="home-page">
      {isLeftNavbar && (
        <Navbar
          activeAssistant={activeAssistant}
          activeTopic={activeTopic}
          setActiveTopic={setActiveTopic}
          setActiveAssistant={setActiveAssistant}
          position="left"
        />
      )}
      <ContentContainer id={isLeftNavbar ? 'content-container' : undefined}>
        <AnimatePresence initial={false}>
          {showAssistants && (
            <ErrorBoundary>
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 'var(--assistants-width)', opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
                style={{ overflow: 'hidden' }}>
                <HomeTabs
                  activeAssistant={activeAssistant}
                  activeTopic={activeTopic}
                  setActiveAssistant={setActiveAssistant}
                  setActiveTopic={setActiveTopic}
                  onCreateConversation={() => void createConversation()}
                  position="left"
                  mode="conversations-only"
                  onOpenTopics={() =>
                    void TopicsDrawer.show({
                      activeAssistant,
                      setActiveAssistant,
                      activeTopic,
                      setActiveTopic
                    })
                  }
                />
              </motion.div>
            </ErrorBoundary>
          )}
        </AnimatePresence>
        <ErrorBoundary>
          {activeAssistant && activeTopic && (
            <Chat
              assistants={assistants}
              assistant={activeAssistant}
              activeTopic={activeTopic}
              setActiveTopic={setActiveTopic}
              setActiveAssistant={bindAssistantToActiveTopic}
            />
          )}
        </ErrorBoundary>
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  [navbar-position='left'] & {
    max-width: calc(100vw - var(--sidebar-width));
  }
  [navbar-position='top'] & {
    max-width: 100vw;
  }
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  overflow: hidden;
  background: #ffffff;

  [navbar-position='top'] & {
    max-width: calc(100vw - 12px);
  }
`

export default HomePage
