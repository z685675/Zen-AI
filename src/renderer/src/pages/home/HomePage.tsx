import { loggerService } from '@logger'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import db from '@renderer/databases'
import { useAssistants, useDefaultModel } from '@renderer/hooks/useAssistant'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants, useShowTopics } from '@renderer/hooks/useStore'
import { autoRenameTopic, clearCachedActiveTopic, useActiveTopic } from '@renderer/hooks/useTopic'
import i18n from '@renderer/i18n'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { CacheService } from '@renderer/services/CacheService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import NavigationService from '@renderer/services/NavigationService'
import store, { useAppSelector } from '@renderer/store'
import {
  addTopic as addTopicAction,
  removeTopic as removeTopicAction,
  updateTopic as updateTopicAction
} from '@renderer/store/assistants'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import type { Assistant, Topic } from '@renderer/types'
import { isUnnamedAgentSessionName } from '@renderer/utils/agentSessionTitle'
import {
  consumeLocallyVerifiedEmptyConversation,
  getChatTopicDraftCacheKey,
  hasUnsentConversationDraft,
  markLocallyVerifiedEmptyConversation,
  shouldDiscardEmptyConversation,
  sortConversationTopics
} from '@renderer/utils/conversationDraft'
import { getNewConversationModel, isSameModel } from '@renderer/utils/conversationModel'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, SECOND_MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch } from 'react-redux'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import Chat from './Chat'
import TopicsDrawer from './components/TopicsDrawer'
import Navbar from './Navbar'
import HomeTabs from './Tabs'

let _activeAssistant: Assistant
const logger = loggerService.withContext('HomePage')

const HomePage: FC = () => {
  const { assistants } = useAssistants()
  const { defaultModel } = useDefaultModel()
  const navigate = useNavigate()
  const { isLeftNavbar } = useNavbarPosition()
  const location = useLocation()
  const state = location.state
  const dispatch = useDispatch()

  const { showAssistants, showTopics, topicPosition } = useSettings()
  const { setShowAssistants, toggleShowAssistants } = useShowAssistants()
  const { toggleShowTopics } = useShowTopics()
  const topicLoadingQuery = useAppSelector((state) => state.messages.loadingByTopic)

  const defaultConversationAssistant = useMemo(
    () => assistants.find((assistant) => assistant.id === 'default') || assistants[0],
    [assistants]
  )

  const [activeAssistant, _setActiveAssistant] = useState<Assistant>(
    state?.assistant || _activeAssistant || defaultConversationAssistant
  )
  const { activeTopic, setActiveTopic: _setActiveTopic } = useActiveTopic(activeAssistant?.id ?? '', state?.topic)
  const latestActiveAssistant = useMemo(
    () => assistants.find((assistant) => assistant.id === activeAssistant?.id),
    [activeAssistant?.id, assistants]
  )
  const activeTopicRef = useRef<Topic | undefined>(undefined)
  const topicsBeingDiscardedRef = useRef(new Set<string>())
  const titleRepairAttemptsRef = useRef(new Set<string>())
  const creatingConversationRef = useRef(false)
  const [entryRestored, setEntryRestored] = useState(false)
  const [isConversationHistoryCollapsed, setIsConversationHistoryCollapsed] = useState(false)

  const isConversationHistoryVisible = showAssistants && !isConversationHistoryCollapsed
  const showConversationHistory = useCallback(() => {
    setShowAssistants(true)
    setIsConversationHistoryCollapsed(false)
  }, [setShowAssistants])

  _activeAssistant = activeAssistant

  const discardAbandonedTopic = useCallback(
    async (topic: Topic) => {
      if (topicsBeingDiscardedRef.current.has(topic.id)) {
        return
      }

      const draftCacheKey = getChatTopicDraftCacheKey(topic.id)
      const stateBeforeRead = store.getState()
      if (
        !shouldDiscardEmptyConversation({
          draft: CacheService.get(draftCacheKey),
          isLoading: Boolean(stateBeforeRead.messages.loadingByTopic[topic.id]),
          messageCount: selectMessagesForTopic(stateBeforeRead, topic.id).length
        })
      ) {
        return
      }

      topicsBeingDiscardedRef.current.add(topic.id)
      const wasLocallyVerifiedEmpty = consumeLocallyVerifiedEmptyConversation(topic.id)
      try {
        if (wasLocallyVerifiedEmpty) {
          CacheService.remove(draftCacheKey)
          clearCachedActiveTopic(topic.id)
          dispatch(newMessagesActions.clearTopicMessages(topic.id))
          dispatch(removeTopicAction({ assistantId: topic.assistantId, topic }))

          try {
            await db.topics.delete(topic.id)
          } catch (error) {
            dispatch(addTopicAction({ assistantId: topic.assistantId, topic }))
            throw error
          }
          return
        }

        const persistedTopic = await db.topics.get(topic.id)
        const latestState = store.getState()
        const messageCount = Math.max(
          persistedTopic?.messages?.length ?? 0,
          selectMessagesForTopic(latestState, topic.id).length
        )

        if (
          !shouldDiscardEmptyConversation({
            draft: CacheService.get(draftCacheKey),
            isLoading: Boolean(latestState.messages.loadingByTopic[topic.id]),
            messageCount
          })
        ) {
          return
        }

        await db.topics.delete(topic.id)
        CacheService.remove(draftCacheKey)
        clearCachedActiveTopic(topic.id)
        dispatch(newMessagesActions.clearTopicMessages(topic.id))
        dispatch(removeTopicAction({ assistantId: topic.assistantId, topic }))
      } catch (error) {
        logger.warn('Failed to discard an abandoned empty chat topic', error as Error)
      } finally {
        topicsBeingDiscardedRef.current.delete(topic.id)
      }
    },
    [dispatch]
  )

  useEffect(() => {
    const previousTopic = activeTopicRef.current
    activeTopicRef.current = activeTopic

    if (previousTopic && previousTopic.id !== activeTopic?.id) {
      void discardAbandonedTopic(previousTopic)
    }
  }, [activeTopic, discardAbandonedTopic])

  useEffect(
    () => () => {
      const currentTopic = activeTopicRef.current
      if (currentTopic) {
        const draft = CacheService.get(getChatTopicDraftCacheKey(currentTopic.id))
        if (!hasUnsentConversationDraft(draft)) {
          clearCachedActiveTopic(currentTopic.id)
        }
        void discardAbandonedTopic(currentTopic)
      }
    },
    [discardAbandonedTopic]
  )

  useEffect(() => {
    let cancelled = false

    const repairMissingTopicTitles = async () => {
      const localizedPlaceholder = i18n.t('chat.default.topic.name')

      for (const assistant of assistants) {
        for (const topic of assistant.topics || []) {
          if (
            cancelled ||
            topic.isNameManuallyEdited ||
            topicLoadingQuery[topic.id] ||
            titleRepairAttemptsRef.current.has(topic.id) ||
            !isUnnamedAgentSessionName(topic.name, localizedPlaceholder)
          ) {
            continue
          }

          const persistedTopic = await db.topics.get(topic.id)
          if (cancelled) {
            return
          }
          if (!persistedTopic?.messages?.length) {
            continue
          }

          titleRepairAttemptsRef.current.add(topic.id)
          const repaired = await autoRenameTopic(assistant, topic.id, { preferGeneratedTitle: false })
          if (!repaired) {
            titleRepairAttemptsRef.current.delete(topic.id)
          }
        }
      }
    }

    void repairMissingTopicTitles()
    return () => {
      cancelled = true
    }
  }, [assistants, topicLoadingQuery])

  const createTopicForAssistant = useCallback(
    async (assistant: Assistant) => {
      const topic = getDefaultTopic(assistant.id, getNewConversationModel(assistant, defaultModel))
      await db.topics.add({ id: topic.id, messages: [] })
      markLocallyVerifiedEmptyConversation(topic.id)
      dispatch(addTopicAction({ assistantId: assistant.id, topic }))
      return topic
    },
    [defaultModel, dispatch]
  )

  const findMessageFreeTopic = useCallback(async (topics: Topic[]) => {
    for (const topic of sortConversationTopics(topics)) {
      const currentState = store.getState()
      if (currentState.messages.loadingByTopic[topic.id] || selectMessagesForTopic(currentState, topic.id).length > 0) {
        continue
      }

      const dbTopic = await db.topics.get(topic.id)
      const latestState = store.getState()
      if (
        !latestState.messages.loadingByTopic[topic.id] &&
        selectMessagesForTopic(latestState, topic.id).length === 0 &&
        (dbTopic?.messages?.length || 0) === 0
      ) {
        markLocallyVerifiedEmptyConversation(topic.id)
        return topic
      }
    }

    return undefined
  }, [])

  const findTopRestorableTopic = useCallback(async () => {
    const currentAssistants = store.getState().assistants.assistants
    const topics = sortConversationTopics(currentAssistants.flatMap((assistant) => assistant.topics || []))

    for (const topic of topics) {
      const currentState = store.getState()
      if (
        topic.isNameManuallyEdited ||
        hasUnsentConversationDraft(CacheService.get(getChatTopicDraftCacheKey(topic.id))) ||
        currentState.messages.loadingByTopic[topic.id] ||
        selectMessagesForTopic(currentState, topic.id).length > 0
      ) {
        return topic
      }

      const persistedTopic = await db.topics.get(topic.id)
      if ((persistedTopic?.messages?.length || 0) > 0) {
        return topic
      }
    }

    return undefined
  }, [])

  const getOrCreateEmptyTopicForAssistant = useCallback(
    async (assistant: Assistant) => {
      const currentAssistant =
        store.getState().assistants.assistants.find((candidate) => candidate.id === assistant.id) || assistant
      const expectedModel = getNewConversationModel(assistant, defaultModel)
      const topic = await findMessageFreeTopic(currentAssistant.topics || [])
      if (topic) {
        if (!isSameModel(topic.model, expectedModel)) {
          const alignedTopic = { ...topic, model: expectedModel }
          dispatch(updateTopicAction({ assistantId: assistant.id, topic: alignedTopic }))
          return alignedTopic
        }
        return topic
      }

      return await createTopicForAssistant(assistant)
    },
    [createTopicForAssistant, defaultModel, dispatch, findMessageFreeTopic]
  )

  useEffect(() => {
    if (entryRestored || !defaultConversationAssistant) {
      return
    }

    if (state?.topic) {
      setEntryRestored(true)
      return
    }

    let cancelled = false

    const restoreTopConversation = async () => {
      const topTopic = await findTopRestorableTopic()
      if (cancelled) {
        return
      }

      const topic = topTopic || (await getOrCreateEmptyTopicForAssistant(defaultConversationAssistant))
      if (cancelled) {
        return
      }

      const topicAssistant =
        store.getState().assistants.assistants.find((assistant) => assistant.id === topic.assistantId) ||
        defaultConversationAssistant
      _setActiveAssistant(topicAssistant)
      _setActiveTopic(topic)
      setEntryRestored(true)
    }

    void restoreTopConversation()
    return () => {
      cancelled = true
    }
  }, [
    _setActiveTopic,
    defaultConversationAssistant,
    entryRestored,
    findTopRestorableTopic,
    getOrCreateEmptyTopicForAssistant,
    state?.topic
  ])

  const setActiveAssistant = useCallback(
    async (newAssistant: Assistant) => {
      if (!newAssistant || newAssistant.id === activeAssistant?.id) return

      const nextTopic = await getOrCreateEmptyTopicForAssistant(newAssistant)
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

      // A direct user navigation must remain urgent. Streaming and context preparation
      // can continuously pre-empt a transition and make a history item appear unresponsive.
      if (topicAssistant && topicAssistant.id !== activeAssistant?.id) {
        _setActiveAssistant(topicAssistant)
      }
      const isCurrentTopic = newTopic.id === activeTopic?.id
      _setActiveTopic(newTopic)
      if (!isCurrentTopic) {
        dispatch(newMessagesActions.setTopicFulfilled({ topicId: newTopic.id, fulfilled: false }))
      }
    },
    [_setActiveTopic, activeAssistant, activeTopic?.id, assistants, dispatch]
  )

  const bindAssistantToActiveTopic = useCallback(
    async (targetAssistant: Assistant) => {
      if (!targetAssistant || !activeTopic) {
        return
      }

      const sourceAssistant =
        assistants.find((assistant) => assistant.id === activeTopic.assistantId) || activeAssistant

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

      if (isDraftTopic) {
        const nextTopic = await getOrCreateEmptyTopicForAssistant(targetAssistant)

        startTransition(() => {
          _setActiveAssistant(targetAssistant)
          _setActiveTopic(nextTopic)
        })

        return
      }

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
    [_setActiveTopic, activeAssistant, activeTopic, assistants, dispatch, getOrCreateEmptyTopicForAssistant]
  )

  const createConversation = useCallback(async () => {
    if (!defaultConversationAssistant || creatingConversationRef.current) {
      return
    }

    creatingConversationRef.current = true
    try {
      // A role selected for the current topic must not become the next topic's default.
      const allTopics = assistants.flatMap((assistant) => assistant.topics || [])
      const reusableTopic = await getOrCreateEmptyTopicForAssistant(defaultConversationAssistant)
      const latestTopicTimestamp = allTopics.reduce(
        (latest, current) => Math.max(latest, new Date(current.updatedAt || current.createdAt || 0).getTime()),
        Date.now()
      )
      const topic = {
        ...reusableTopic,
        assistantId: defaultConversationAssistant.id,
        enableWebSearch: false,
        updatedAt: new Date(latestTopicTimestamp + 1).toISOString()
      }
      dispatch(updateTopicAction({ assistantId: defaultConversationAssistant.id, topic }))
      _setActiveAssistant(defaultConversationAssistant)
      _setActiveTopic(topic)
      dispatch(newMessagesActions.setTopicFulfilled({ topicId: topic.id, fulfilled: false }))
    } finally {
      creatingConversationRef.current = false
    }
  }, [_setActiveTopic, assistants, defaultConversationAssistant, dispatch, getOrCreateEmptyTopicForAssistant])

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
    if (latestActiveAssistant && latestActiveAssistant !== activeAssistant) {
      _setActiveAssistant(latestActiveAssistant)
    }
  }, [activeAssistant, latestActiveAssistant])

  useEffect(() => {
    if (!entryRestored || activeTopic || !activeAssistant) {
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
  }, [activeAssistant, activeTopic, _setActiveTopic, entryRestored, getOrCreateEmptyTopicForAssistant])

  useEffect(() => {
    const exists = assistants.some((assistant) => assistant.id === activeAssistant?.id)
    if (!exists && defaultConversationAssistant) {
      _setActiveAssistant(defaultConversationAssistant)
    }
  }, [activeAssistant?.id, assistants, defaultConversationAssistant])

  useEffect(() => {
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.SHOW_TOPIC_SIDEBAR, () => {
        if (!isLeftNavbar || !activeAssistant || !activeTopic) return
        void TopicsDrawer.show({
          activeAssistant,
          setActiveAssistant,
          activeTopic,
          setActiveTopic
        })
      }),
      EventEmitter.on(EVENT_NAMES.SWITCH_TOPIC_SIDEBAR, () => {
        if (!isLeftNavbar || !activeAssistant || !activeTopic) return
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
    const canMinimize =
      topicPosition == 'left' ? !isConversationHistoryVisible : !isConversationHistoryVisible && !showTopics
    void window.api.window.setMinimumSize(canMinimize ? SECOND_MIN_WINDOW_WIDTH : MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)

    return () => {
      void window.api.window.resetMinimumSize()
    }
  }, [isConversationHistoryVisible, showTopics, topicPosition])

  return (
    <Container id="home-page">
      {isLeftNavbar && activeAssistant && activeTopic && (
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
          {isConversationHistoryVisible && activeAssistant && activeTopic && (
            <ErrorBoundary>
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 'var(--conversation-history-width)', opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
                style={{ overflow: 'hidden' }}>
                <HomeTabs
                  activeAssistant={activeAssistant}
                  activeTopic={activeTopic}
                  setActiveAssistant={setActiveAssistant}
                  setActiveTopic={setActiveTopic}
                  onCreateConversation={() => void createConversation()}
                  onCollapseConversationHistory={() => setIsConversationHistoryCollapsed(true)}
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
              onCreateConversation={createConversation}
              isConversationHistoryVisible={isConversationHistoryVisible}
              onShowConversationHistory={showConversationHistory}
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
