/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
// @ts-nocheck
import type { PayloadAction } from '@reduxjs/toolkit'
import { createSelector, createSlice } from '@reduxjs/toolkit'
import { DEFAULT_CONTEXTCOUNT, DEFAULT_TEMPERATURE } from '@renderer/config/constant'
import { TopicManager } from '@renderer/hooks/useTopic'
import { DEFAULT_ASSISTANT_SETTINGS, getDefaultAssistant, getDefaultTopic } from '@renderer/services/AssistantService'
import type { Assistant, AssistantPreset, AssistantSettings, ConversationFolder, Model, Topic } from '@renderer/types'
import { isEmpty, uniqBy } from 'lodash'

import type { RootState } from '.'

export interface AssistantsState {
  defaultAssistant: Assistant
  assistants: Assistant[]
  tagsOrder: string[]
  collapsedTags: Record<string, boolean>
  presets: AssistantPreset[]
  quickAssistantIds: string[]
  conversationFolders: ConversationFolder[]
  collapsedConversationFolders: Record<string, boolean>
  /** @deprecated should be removed in v2 */
  unifiedListOrder: Array<{ type: 'agent' | 'assistant'; id: string }>
}

const initialState: AssistantsState = {
  defaultAssistant: getDefaultAssistant(),
  assistants: [getDefaultAssistant()],
  tagsOrder: [],
  collapsedTags: {},
  presets: [],
  quickAssistantIds: [],
  conversationFolders: [],
  collapsedConversationFolders: {},
  unifiedListOrder: []
}

const normalizeTopics = (topics: unknown): Topic[] => (Array.isArray(topics) ? topics : [])
const normalizeConversationFolders = (folders: unknown): ConversationFolder[] =>
  Array.isArray(folders) ? folders : []

const cleanupTouchedConversationFolders = (state: AssistantsState, previousFolders: ConversationFolder[]) => {
  const nextFolders = normalizeConversationFolders(state.conversationFolders)
  const previousFolderMap = new Map(previousFolders.map((folder) => [folder.id, folder]))
  const touchedFolderIds = new Set<string>()

  nextFolders.forEach((folder) => {
    const previousFolder = previousFolderMap.get(folder.id)

    if (!previousFolder) {
      return
    }

    if (previousFolder.topicIds.join('::') !== folder.topicIds.join('::')) {
      touchedFolderIds.add(folder.id)
    }
  })

  const keptFolders = nextFolders.filter((folder) => !(touchedFolderIds.has(folder.id) && folder.topicIds.length === 0))
  const nextFolderIds = new Set(keptFolders.map((folder) => folder.id))

  state.conversationFolders = keptFolders

  if (!state.collapsedConversationFolders) {
    return
  }

  Object.keys(state.collapsedConversationFolders).forEach((folderId) => {
    if (!nextFolderIds.has(folderId)) {
      delete state.collapsedConversationFolders[folderId]
    }
  })
}

const assistantsSlice = createSlice({
  name: 'assistants',
  initialState,
  reducers: {
    updateDefaultAssistant: (state, action: PayloadAction<{ assistant: Assistant }>) => {
      // @ts-ignore ts2589
      state.defaultAssistant = action.payload.assistant
    },
    updateAssistants: (state, action: PayloadAction<Assistant[]>) => {
      state.assistants = action.payload
    },
    addAssistant: (state, action: PayloadAction<Assistant>) => {
      state.assistants.unshift(action.payload)
    },
    insertAssistant: (state, action: PayloadAction<{ index: number; assistant: Assistant }>) => {
      const { index, assistant } = action.payload

      if (index < 0 || index > state.assistants.length) {
        throw new Error(`InsertAssistant: index ${index} is out of bounds [0, ${state.assistants.length}]`)
      }

      state.assistants.splice(index, 0, assistant)
    },
    removeAssistant: (state, action: PayloadAction<{ id: string }>) => {
      const previousFolders = normalizeConversationFolders(state.conversationFolders)
      const removedAssistant = state.assistants.find((c) => c.id === action.payload.id)
      const removedTopicIds = normalizeTopics(removedAssistant?.topics).map((topic) => topic.id)
      state.assistants = state.assistants.filter((c) => c.id !== action.payload.id)
      state.quickAssistantIds = state.quickAssistantIds.filter((id) => id !== action.payload.id)
      if (removedTopicIds.length > 0) {
        state.conversationFolders = normalizeConversationFolders(state.conversationFolders)
          .map((folder) => ({
            ...folder,
            topicIds: folder.topicIds.filter((topicId) => !removedTopicIds.includes(topicId))
          }))
        cleanupTouchedConversationFolders(state, previousFolders)
      }
    },
    updateAssistant: (state, action: PayloadAction<Partial<Assistant> & { id: string }>) => {
      const { id, ...update } = action.payload
      // @ts-ignore ts2589
      state.assistants = state.assistants.map((c) => (c.id === id ? { ...c, ...update } : c))
    },
    updateAssistantSettings: (
      state,
      action: PayloadAction<{ assistantId: string; settings: Partial<AssistantSettings> }>
    ) => {
      for (const assistant of state.assistants) {
        const settings = action.payload.settings
        if (assistant.id === action.payload.assistantId) {
          for (const key in settings) {
            if (!assistant.settings) {
              assistant.settings = {
                temperature: DEFAULT_TEMPERATURE,
                contextCount: DEFAULT_CONTEXTCOUNT,
                enableMaxTokens: false,
                maxTokens: 0,
                streamOutput: true
              }
            }
            assistant.settings[key] = settings[key]
          }
        }
      }
    },
    setTagsOrder: (state, action: PayloadAction<string[]>) => {
      const newOrder = action.payload
      state.tagsOrder = newOrder
      const prevCollapsed = state.collapsedTags || {}
      const updatedCollapsed: Record<string, boolean> = { ...prevCollapsed }
      newOrder.forEach((tag) => {
        if (!(tag in updatedCollapsed)) {
          updatedCollapsed[tag] = false
        }
      })
      state.collapsedTags = updatedCollapsed
    },
    updateTagCollapse: (state, action: PayloadAction<string>) => {
      const tag = action.payload
      const prev = state.collapsedTags || {}
      state.collapsedTags = {
        ...prev,
        [tag]: !prev[tag]
      }
    },
    setUnifiedListOrder: (state, action: PayloadAction<Array<{ type: 'agent' | 'assistant'; id: string }>>) => {
      state.unifiedListOrder = action.payload
    },
    addTopic: (state, action: PayloadAction<{ assistantId: string; topic: Topic }>) => {
      const topic = action.payload.topic
      topic.createdAt = topic.createdAt || new Date().toISOString()
      topic.updatedAt = topic.updatedAt || new Date().toISOString()
      state.assistants = state.assistants.map((assistant) =>
        assistant.id === action.payload.assistantId
          ? {
              ...assistant,
              topics: uniqBy([topic, ...normalizeTopics(assistant.topics)], 'id')
            }
          : assistant
      )
    },
    removeTopic: (state, action: PayloadAction<{ assistantId: string; topic: Topic }>) => {
      const previousFolders = normalizeConversationFolders(state.conversationFolders)
      state.assistants = state.assistants.map((assistant) =>
        assistant.id === action.payload.assistantId
          ? {
              ...assistant,
              topics: normalizeTopics(assistant.topics).filter(({ id }) => id !== action.payload.topic.id)
            }
          : assistant
      )
      state.conversationFolders = normalizeConversationFolders(state.conversationFolders)
        .map((folder) => ({
          ...folder,
          topicIds: folder.topicIds.filter((topicId) => topicId !== action.payload.topic.id)
        }))
      cleanupTouchedConversationFolders(state, previousFolders)
    },
    updateTopic: (state, action: PayloadAction<{ assistantId: string; topic: Topic }>) => {
      const newTopic = action.payload.topic
      newTopic.updatedAt = new Date().toISOString()
      state.assistants = state.assistants.map((assistant) =>
        assistant.id === action.payload.assistantId
          ? {
              ...assistant,
              topics: normalizeTopics(assistant.topics).map((topic) => {
                const _topic = topic.id === newTopic.id ? newTopic : topic
                _topic.messages = []
                return _topic
              })
            }
          : assistant
      )
    },
    updateTopics: (state, action: PayloadAction<{ assistantId: string; topics: Topic[] }>) => {
      state.assistants = state.assistants.map((assistant) =>
        assistant.id === action.payload.assistantId
          ? {
              ...assistant,
              topics: action.payload.topics.map((topic) =>
                isEmpty(topic.messages) ? topic : { ...topic, messages: [] }
              )
            }
          : assistant
      )
    },
    removeAllTopics: (state, action: PayloadAction<{ assistantId: string }>) => {
      const previousFolders = normalizeConversationFolders(state.conversationFolders)
      state.assistants = state.assistants.map((assistant) => {
        if (assistant.id === action.payload.assistantId) {
          const removedTopicIds = normalizeTopics(assistant.topics).map((topic) => topic.id)
          normalizeTopics(assistant.topics).forEach((topic) => TopicManager.removeTopic(topic.id))
          state.conversationFolders = normalizeConversationFolders(state.conversationFolders)
            .map((folder) => ({
              ...folder,
              topicIds: folder.topicIds.filter((topicId) => !removedTopicIds.includes(topicId))
            }))
          return {
            ...assistant,
            topics: [getDefaultTopic(assistant.id)]
          }
        }
        return assistant
      })
      cleanupTouchedConversationFolders(state, previousFolders)
    },
    updateTopicUpdatedAt: (state, action: PayloadAction<{ topicId: string }>) => {
      outer: for (const assistant of state.assistants) {
        for (const topic of normalizeTopics(assistant.topics)) {
          if (topic.id === action.payload.topicId) {
            topic.updatedAt = new Date().toISOString()
            break outer
          }
        }
      }
    },
    setModel: (state, action: PayloadAction<{ assistantId: string; model: Model }>) => {
      state.assistants = state.assistants.map((assistant) =>
        assistant.id === action.payload.assistantId
          ? {
              ...assistant,
              model: action.payload.model
            }
          : assistant
      )
    },
    // Assistant Presets
    setAssistantPresets: (state, action: PayloadAction<AssistantPreset[]>) => {
      const presets = action.payload
      state.presets = []
      presets.forEach((p) => {
        state.presets.push(p)
      })
    },
    addAssistantPreset: (state, action: PayloadAction<AssistantPreset>) => {
      state.presets.push(action.payload)
    },
    setQuickAssistantIds: (state, action: PayloadAction<string[]>) => {
      state.quickAssistantIds = Array.from(new Set(action.payload))
    },
    addQuickAssistantId: (state, action: PayloadAction<string>) => {
      if (!state.quickAssistantIds.includes(action.payload)) {
        state.quickAssistantIds.push(action.payload)
      }
    },
    removeQuickAssistantId: (state, action: PayloadAction<string>) => {
      state.quickAssistantIds = state.quickAssistantIds.filter((id) => id !== action.payload)
    },
    removeAssistantPreset: (state, action: PayloadAction<{ id: string }>) => {
      state.presets = state.presets.filter((c) => c.id !== action.payload.id)
    },
    updateAssistantPreset: (state, action: PayloadAction<AssistantPreset>) => {
      const preset = action.payload
      const index = state.presets.findIndex((a) => a.id === preset.id)
      if (index !== -1) {
        state.presets[index] = preset
      }
    },
    updateAssistantPresetSettings: (
      state,
      action: PayloadAction<{ assistantId: string; settings: Partial<AssistantSettings> }>
    ) => {
      for (const agent of state.presets) {
        const settings = action.payload.settings
        if (agent.id === action.payload.assistantId) {
          for (const key in settings) {
            if (!agent.settings) {
              agent.settings = { ...DEFAULT_ASSISTANT_SETTINGS }
            }
            agent.settings[key] = settings[key]
          }
        }
      }
    },
    createConversationFolder: (state, action: PayloadAction<{ id: string; name: string }>) => {
      const timestamp = new Date().toISOString()
      state.conversationFolders = [
        ...normalizeConversationFolders(state.conversationFolders),
        {
          id: action.payload.id,
          name: action.payload.name,
          topicIds: [],
          createdAt: timestamp,
          updatedAt: timestamp
        }
      ]
      state.collapsedConversationFolders = {
        ...(state.collapsedConversationFolders || {}),
        [action.payload.id]: false
      }
    },
    renameConversationFolder: (state, action: PayloadAction<{ id: string; name: string }>) => {
      state.conversationFolders = normalizeConversationFolders(state.conversationFolders).map((folder) =>
        folder.id === action.payload.id
          ? {
              ...folder,
              name: action.payload.name,
              updatedAt: new Date().toISOString()
            }
          : folder
      )
    },
    reorderConversationFolders: (state, action: PayloadAction<{ oldIndex: number; newIndex: number }>) => {
      const folders = [...normalizeConversationFolders(state.conversationFolders)]
      const { oldIndex, newIndex } = action.payload

      if (
        oldIndex === newIndex ||
        oldIndex < 0 ||
        newIndex < 0 ||
        oldIndex >= folders.length ||
        newIndex >= folders.length
      ) {
        return
      }

      const [movedFolder] = folders.splice(oldIndex, 1)
      folders.splice(newIndex, 0, movedFolder)
      state.conversationFolders = folders
    },
    deleteConversationFolder: (state, action: PayloadAction<{ id: string }>) => {
      state.conversationFolders = normalizeConversationFolders(state.conversationFolders).filter(
        (folder) => folder.id !== action.payload.id
      )
      if (state.collapsedConversationFolders?.[action.payload.id] !== undefined) {
        delete state.collapsedConversationFolders[action.payload.id]
      }
    },
    toggleConversationFolderCollapsed: (state, action: PayloadAction<{ id: string }>) => {
      state.collapsedConversationFolders = {
        ...(state.collapsedConversationFolders || {}),
        [action.payload.id]: !state.collapsedConversationFolders?.[action.payload.id]
      }
    },
    moveTopicToConversationFolder: (state, action: PayloadAction<{ topicId: string; folderId?: string }>) => {
      const previousFolders = normalizeConversationFolders(state.conversationFolders)
      const { topicId, folderId } = action.payload
      const timestamp = new Date().toISOString()
      state.conversationFolders = normalizeConversationFolders(state.conversationFolders).map((folder) => {
        const nextTopicIds = folder.topicIds.filter((id) => id !== topicId)
        if (folder.id === folderId) {
          nextTopicIds.push(topicId)
        }
        return {
          ...folder,
          topicIds: nextTopicIds,
          updatedAt: folder.id === folderId || folder.topicIds.includes(topicId) ? timestamp : folder.updatedAt
        }
      })
      cleanupTouchedConversationFolders(state, previousFolders)
    }
  }
})

export const {
  updateDefaultAssistant,
  updateAssistants,
  addAssistant,
  insertAssistant,
  removeAssistant,
  updateAssistant,
  addTopic,
  removeTopic,
  updateTopic,
  updateTopics,
  removeAllTopics,
  updateTopicUpdatedAt,
  setModel,
  setTagsOrder,
  updateAssistantSettings,
  updateTagCollapse,
  setUnifiedListOrder,
  setAssistantPresets,
  addAssistantPreset,
  setQuickAssistantIds,
  addQuickAssistantId,
  removeQuickAssistantId,
  createConversationFolder,
  renameConversationFolder,
  reorderConversationFolders,
  deleteConversationFolder,
  toggleConversationFolderCollapsed,
  moveTopicToConversationFolder,
  removeAssistantPreset,
  updateAssistantPreset,
  updateAssistantPresetSettings
} = assistantsSlice.actions

export const selectAllTopics = createSelector([(state: RootState) => state.assistants.assistants], (assistants) =>
  assistants.flatMap((assistant: Assistant) => normalizeTopics(assistant.topics))
)

export const selectTopicsMap = createSelector([selectAllTopics], (topics) => {
  return topics.reduce((map, topic) => {
    map.set(topic.id, topic)
    return map
  }, new Map())
})

export const selectConversationFolders = createSelector(
  [(state: RootState) => state.assistants.conversationFolders],
  (folders) => normalizeConversationFolders(folders)
)

export default assistantsSlice.reducer
