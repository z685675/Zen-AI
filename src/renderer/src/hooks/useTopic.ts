import { loggerService } from '@logger'
import db from '@renderer/databases'
import i18n from '@renderer/i18n'
import { fetchMessagesSummary } from '@renderer/services/ApiService'
import { clearContextCheckpoint } from '@renderer/services/context/ContextCompactionService'
import { clearContextTelemetry } from '@renderer/services/context/ContextTelemetryService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { safeDeleteFiles } from '@renderer/services/MessagesService'
import store from '@renderer/store'
import { updateTopic } from '@renderer/store/assistants'
import { setNewlyRenamedTopics, setRenamingTopics } from '@renderer/store/runtime'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant, FileMetadata, Topic } from '@renderer/types'
import type { FileMessageBlock, ImageMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { findMainTextBlocks } from '@renderer/utils/messageUtils/find'
import { truncateText } from '@renderer/utils/naming'
import { isEmpty } from 'lodash'
import { type Dispatch, type SetStateAction, useEffect, useState } from 'react'

import { useAssistant } from './useAssistant'
import { getStoreSetting } from './useSettings'

let _activeTopic: Topic | undefined
let _setActiveTopic: Dispatch<SetStateAction<Topic | undefined>> | undefined

const logger = loggerService.withContext('useTopic')

export function useActiveTopic(assistantId: string, topic?: Topic) {
  const { assistant } = useAssistant(assistantId)
  const [activeTopic, setActiveTopic] = useState<Topic | undefined>(topic || _activeTopic || assistant?.topics[0])

  _activeTopic = activeTopic
  _setActiveTopic = setActiveTopic

  useEffect(() => {
    if (activeTopic) {
      void store.dispatch(loadTopicMessagesThunk(activeTopic.id))
      void EventEmitter.emit(EVENT_NAMES.CHANGE_TOPIC, activeTopic)
    }
  }, [activeTopic])

  useEffect(() => {
    // During a cross-assistant topic switch, the selected topic can arrive one
    // render before its assistant. Do not let the previous assistant pull it back.
    if (activeTopic?.assistantId && activeTopic.assistantId !== assistant?.id) {
      return
    }

    if (assistant?.topics?.length && (!activeTopic || !assistant.topics.find((item) => item.id === activeTopic.id))) {
      const newestTopic = [...assistant.topics].sort((a, b) => {
        const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime()
        const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime()
        return bTime - aTime
      })[0]

      setActiveTopic(newestTopic || assistant.topics[0])
    }
  }, [activeTopic, assistant])

  useEffect(() => {
    if (!assistant?.topics?.length || !activeTopic) {
      return
    }

    if (activeTopic.assistantId && activeTopic.assistantId !== assistant.id) {
      return
    }

    const latestTopic = assistant.topics.find((item) => item.id === activeTopic.id)
    if (latestTopic && latestTopic !== activeTopic) {
      setActiveTopic(latestTopic)
    }
  }, [assistant.id, assistant?.topics, activeTopic])

  return { activeTopic, setActiveTopic }
}

export function useTopic(assistant: Assistant, topicId?: string) {
  return assistant?.topics.find((topic) => topic.id === topicId)
}

export function getTopic(assistant: Assistant, topicId: string) {
  return assistant?.topics.find((topic) => topic.id === topicId)
}

export async function getTopicById(topicId: string) {
  const assistants = store.getState().assistants.assistants
  const topics = assistants.map((assistant) => assistant.topics).flat()
  const topic = topics.find((item) => item.id === topicId)
  const dbTopic = await TopicManager.getTopic(topicId)
  const messages = await TopicManager.getTopicMessages(topicId)
  const baseTopic = topic || dbTopic

  if (!baseTopic) {
    return null
  }

  return { ...baseTopic, messages } as Topic
}

export const startTopicRenaming = (topicId: string) => {
  const currentIds = store.getState().runtime.chat.renamingTopics
  if (!currentIds.includes(topicId)) {
    store.dispatch(setRenamingTopics([...currentIds, topicId]))
  }
}

export const finishTopicRenaming = (topicId: string) => {
  const state = store.getState()
  const currentRenaming = state.runtime.chat.renamingTopics
  store.dispatch(setRenamingTopics(currentRenaming.filter((id) => id !== topicId)))

  const currentNewlyRenamed = state.runtime.chat.newlyRenamedTopics
  store.dispatch(setNewlyRenamedTopics([...currentNewlyRenamed, topicId]))

  setTimeout(() => {
    const current = store.getState().runtime.chat.newlyRenamedTopics
    store.dispatch(setNewlyRenamedTopics(current.filter((id) => id !== topicId)))
  }, 700)
}

const topicRenamingLocks = new Set<string>()

export const autoRenameTopic = async (assistant: Assistant, topicId: string) => {
  if (topicRenamingLocks.has(topicId)) {
    return
  }

  try {
    topicRenamingLocks.add(topicId)

    const topic = await getTopicById(topicId)
    if (!topic) {
      return
    }

    const enableTopicNaming = getStoreSetting('enableTopicNaming')

    if (isEmpty(topic.messages)) {
      return
    }

    if (topic.isNameManuallyEdited) {
      return
    }

    const applyTopicName = (name: string) => {
      const data = { ...topic, name } as Topic
      const currentActiveTopic = store.getState().runtime.chat.activeTopic
      if (currentActiveTopic?.id === topic.id && _setActiveTopic) {
        _setActiveTopic(data)
      }
      store.dispatch(updateTopic({ assistantId: assistant.id, topic: data }))
    }

    const getFirstMessageName = () => {
      const message = topic.messages[0]
      const blocks = findMainTextBlocks(message)
      const text = blocks
        .map((block) => block.content)
        .join('\n\n')
        .trim()

      return truncateText(text)
    }

    if (!enableTopicNaming) {
      const topicName = getFirstMessageName()
      if (topicName) {
        try {
          startTopicRenaming(topicId)
          applyTopicName(topicName)
        } finally {
          finishTopicRenaming(topicId)
        }
      }
      return
    }

    if (topic && topic.name === i18n.t('chat.default.topic.name') && topic.messages.length >= 2) {
      startTopicRenaming(topicId)
      try {
        const { text: summaryText, error } = await fetchMessagesSummary({ messages: topic.messages })
        if (summaryText) {
          applyTopicName(summaryText)
        } else {
          if (error) {
            window.toast?.error(`${i18n.t('message.error.fetchTopicName')}: ${error}`)
          }
          const fallbackName = getFirstMessageName()
          if (fallbackName) {
            applyTopicName(fallbackName)
          }
        }
      } finally {
        finishTopicRenaming(topicId)
      }
    }
  } finally {
    topicRenamingLocks.delete(topicId)
  }
}

export const TopicManager = {
  async getTopic(id: string) {
    return await db.topics.get(id)
  },

  async getAllTopics() {
    return await db.topics.toArray()
  },

  async getTopicMessages(id: string) {
    const topic = await TopicManager.getTopic(id)
    if (!topic) return []

    await store.dispatch(loadTopicMessagesThunk(id))

    const updatedTopic = await TopicManager.getTopic(id)
    return updatedTopic?.messages || []
  },

  async removeTopic(id: string) {
    await TopicManager.clearTopicMessages(id)
    await db.topics.delete(id)
  },

  async clearTopicMessages(id: string): Promise<void> {
    let filesToDelete: FileMetadata[] = []

    try {
      await db.transaction('rw', [db.topics, db.message_blocks, db.context_resources], async () => {
        const topic = await db.topics.get(id)

        if (!topic || !topic.messages || topic.messages.length === 0) {
          await db.context_resources.where('conversationId').equals(id).delete()
          return
        }

        const blockIds = topic.messages.flatMap((message) => message.blocks || [])

        if (blockIds.length > 0) {
          const blocks = await db.message_blocks.where('id').anyOf(blockIds).toArray()

          filesToDelete = blocks
            .filter(
              (block): block is ImageMessageBlock | FileMessageBlock =>
                block.type === MessageBlockType.IMAGE || block.type === MessageBlockType.FILE
            )
            .map((block) => block.file)
            .filter((file) => file !== undefined)

          await db.message_blocks.bulkDelete(blockIds)
        }

        await db.topics.update(id, { messages: [] })
        await db.context_resources.where('conversationId').equals(id).delete()
      })
      clearContextCheckpoint(id)
      clearContextTelemetry(id)
    } catch (dbError) {
      logger.error(`Failed to clear database records for topic ${id}:`, dbError as Error)
      throw dbError
    }

    if (filesToDelete.length > 0) {
      await safeDeleteFiles(filesToDelete)
    }
  }
}
