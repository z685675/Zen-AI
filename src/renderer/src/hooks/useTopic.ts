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
import type { FileMessageBlock, ImageMessageBlock, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import {
  deriveAgentSessionFallbackTitle,
  isUnnamedAgentSessionName,
  normalizeAgentSessionTitle
} from '@renderer/utils/agentSessionTitle'
import { sortConversationTopics } from '@renderer/utils/conversationDraft'
import { isEmpty } from 'lodash'
import { type Dispatch, type SetStateAction, useEffect, useState } from 'react'

import { useAssistant } from './useAssistant'
import { getStoreSetting } from './useSettings'

let _activeTopic: Topic | undefined
let _setActiveTopic: Dispatch<SetStateAction<Topic | undefined>> | undefined

const logger = loggerService.withContext('useTopic')

export const clearCachedActiveTopic = (topicId: string) => {
  if (_activeTopic?.id === topicId) {
    _activeTopic = undefined
  }
}

export function useActiveTopic(assistantId: string, topic?: Topic) {
  const { assistant } = useAssistant(assistantId)
  const [activeTopic, setActiveTopic] = useState<Topic | undefined>(
    topic || _activeTopic || sortConversationTopics(assistant?.topics || [])[0]
  )

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
      const newestTopic = sortConversationTopics(assistant.topics)[0]

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

export const finishTopicRenaming = (topicId: string, renamed = true) => {
  const state = store.getState()
  const currentRenaming = state.runtime.chat.renamingTopics
  store.dispatch(setRenamingTopics(currentRenaming.filter((id) => id !== topicId)))

  if (!renamed) {
    return
  }

  const currentNewlyRenamed = state.runtime.chat.newlyRenamedTopics
  store.dispatch(setNewlyRenamedTopics([...currentNewlyRenamed, topicId]))

  setTimeout(() => {
    const current = store.getState().runtime.chat.newlyRenamedTopics
    store.dispatch(setNewlyRenamedTopics(current.filter((id) => id !== topicId)))
  }, 700)
}

const topicRenamingLocks = new Set<string>()

type AutoRenameTopicOptions = {
  preferGeneratedTitle?: boolean
}

export const autoRenameTopic = async (
  assistant: Assistant,
  topicId: string,
  options: AutoRenameTopicOptions = {}
): Promise<boolean> => {
  if (topicRenamingLocks.has(topicId)) {
    return false
  }

  try {
    topicRenamingLocks.add(topicId)

    const topic = await getTopicById(topicId)
    if (!topic) {
      return false
    }

    const enableTopicNaming = getStoreSetting('enableTopicNaming')

    if (isEmpty(topic.messages)) {
      return false
    }

    if (topic.isNameManuallyEdited) {
      return false
    }

    const localizedPlaceholder = i18n.t('chat.default.topic.name')
    const canImproveFallbackTitle = options.preferGeneratedTitle !== false && topic.nameSource === 'fallback'
    if (!isUnnamedAgentSessionName(topic.name, localizedPlaceholder) && !canImproveFallbackTitle) {
      return false
    }

    const applyTopicName = (
      rawName: string,
      source: NonNullable<Topic['nameSource']>,
      replaceableNames: string[] = []
    ) => {
      const name = normalizeAgentSessionTitle(rawName)
      if (!name || isUnnamedAgentSessionName(name, localizedPlaceholder)) {
        return false
      }

      const latestAssistant = store
        .getState()
        .assistants.assistants.find((candidate) => candidate.id === topic.assistantId)
      const latestTopic = latestAssistant?.topics.find((candidate) => candidate.id === topic.id)
      if (!latestTopic || latestTopic.isNameManuallyEdited) {
        return false
      }

      const canReplaceCurrentName =
        isUnnamedAgentSessionName(latestTopic.name, localizedPlaceholder) ||
        replaceableNames.includes(latestTopic.name) ||
        (source === 'generated' && latestTopic.nameSource === 'fallback')
      if (!canReplaceCurrentName) {
        return false
      }

      const data = { ...latestTopic, name, isNameManuallyEdited: false, nameSource: source } as Topic
      const currentActiveTopic = store.getState().runtime.chat.activeTopic
      if (currentActiveTopic?.id === topic.id && _setActiveTopic) {
        _setActiveTopic(data)
      }
      store.dispatch(updateTopic({ assistantId: latestTopic.assistantId || assistant.id, topic: data }))
      return true
    }

    const state = store.getState()
    const blocks = topic.messages.flatMap((message) =>
      message.blocks
        .map((blockId) => state.messageBlocks.entities[blockId])
        .filter((block): block is MessageBlock => !!block)
    )
    const fallbackName = deriveAgentSessionFallbackTitle({
      messages: topic.messages,
      blocks
    })
    const shouldGenerateTitle =
      options.preferGeneratedTitle !== false && enableTopicNaming && topic.messages.length >= 2

    if (!fallbackName && !shouldGenerateTitle) {
      return false
    }

    startTopicRenaming(topicId)
    let renamed = false
    try {
      if (fallbackName && topic.nameSource !== 'fallback') {
        renamed = applyTopicName(fallbackName, 'fallback') || renamed
      }

      if (shouldGenerateTitle) {
        try {
          const { text: summaryText, error } = await fetchMessagesSummary({ messages: topic.messages })
          if (summaryText) {
            renamed =
              applyTopicName(
                summaryText,
                'generated',
                fallbackName ? [normalizeAgentSessionTitle(fallbackName)] : []
              ) || renamed
          } else if (error) {
            logger.debug('Keeping local topic title after generated naming failed', {
              topicId,
              error
            })
          }
        } catch (error) {
          logger.debug('Keeping local topic title after generated naming threw', {
            topicId,
            error
          })
        }
      }
    } finally {
      finishTopicRenaming(topicId, renamed)
    }
    return renamed
  } catch (error) {
    logger.warn('Failed to auto-rename chat topic', {
      topicId,
      error
    })
    return false
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
