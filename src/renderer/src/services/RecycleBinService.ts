import { loggerService } from '@logger'
import db from '@renderer/databases'
import { safeDeleteFiles } from '@renderer/services/MessagesService'
import store from '@renderer/store'
import {
  addTopic as addTopicAction,
  createConversationFolder,
  deleteConversationFolder,
  moveTopicToConversationFolder,
  removeTopic as removeTopicAction
} from '@renderer/store/assistants'
import type { ConversationFolder, Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import type { NotesTreeNode, RecycleBinNoteNodeSnapshot } from '@renderer/types/note'
import { uuid } from '@renderer/utils'

const logger = loggerService.withContext('RecycleBinService')

const RECYCLE_BIN_KEY = 'zen-ai:recycle-bin'
export interface RecycleBinTopicItem {
  entryId: string
  deletedAt: string
  topic: Topic
  messages: Message[]
  blocks: MessageBlock[]
  folderId?: string
}

export interface RecycleBinConversationFolderItem {
  entryId: string
  deletedAt: string
  folder: ConversationFolder
}

export interface RecycleBinNoteItem {
  entryId: string
  deletedAt: string
  nodeType: 'file' | 'folder'
  name: string
  originalPath: string
  trashPath: string
  children?: RecycleBinNoteNodeSnapshot[]
}

interface RecycleBinState {
  version: 1
  topics: RecycleBinTopicItem[]
  conversationFolders: RecycleBinConversationFolderItem[]
  notes: RecycleBinNoteItem[]
}

const EMPTY_STATE: RecycleBinState = {
  version: 1,
  topics: [],
  conversationFolders: [],
  notes: []
}

const normalizePath = (input: string) => input.replace(/\\/g, '/').replace(/\/+/g, '/')

const joinPath = (...parts: string[]) =>
  parts
    .filter(Boolean)
    .map((part, index) => {
      const normalized = normalizePath(part)
      if (index === 0) {
        return normalized.replace(/\/+$/, '')
      }
      return normalized.replace(/^\/+/, '').replace(/\/+$/, '')
    })
    .join('/')

const getDirname = (filePath: string) => {
  const normalized = normalizePath(filePath)
  const lastSlashIndex = normalized.lastIndexOf('/')
  return lastSlashIndex > 0 ? normalized.slice(0, lastSlashIndex) : normalized
}

const getBasename = (filePath: string) => {
  const normalized = normalizePath(filePath)
  const lastSlashIndex = normalized.lastIndexOf('/')
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized
}

const getFileNameWithoutExtension = (fileName: string) => {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
}

const dedupeFiles = (files: Array<{ path?: string }>) => {
  const fileMap = new Map<string, { path?: string }>()
  files.forEach((file) => {
    if (file.path && !fileMap.has(file.path)) {
      fileMap.set(file.path, file)
    }
  })
  return Array.from(fileMap.values())
}

const extractFilesFromBlocks = (blocks: MessageBlock[]) => {
  const files = blocks
    .filter((block) => block.type === MessageBlockType.IMAGE || block.type === MessageBlockType.FILE)
    .map((block) => ('file' in block ? block.file : undefined))
    .filter((file): file is NonNullable<(typeof blocks)[number] extends infer T ? T extends { file?: infer F } ? F : never : never> => Boolean(file))

  return dedupeFiles(files)
}

async function readState(): Promise<RecycleBinState> {
  const record = await db.settings.get(RECYCLE_BIN_KEY)
  if (!record?.value) {
    return { ...EMPTY_STATE }
  }

  return {
    version: 1,
    topics: Array.isArray(record.value.topics) ? record.value.topics : [],
    conversationFolders: Array.isArray(record.value.conversationFolders) ? record.value.conversationFolders : [],
    notes: Array.isArray(record.value.notes) ? record.value.notes : []
  }
}

async function writeState(state: RecycleBinState): Promise<void> {
  await db.settings.put({ id: RECYCLE_BIN_KEY, value: state })
}

async function permanentlyDeleteTopicItem(item: RecycleBinTopicItem): Promise<void> {
  const files = extractFilesFromBlocks(item.blocks)
  if (files.length > 0) {
    await safeDeleteFiles(files as any)
  }
}

async function permanentlyDeleteNoteItem(item: RecycleBinNoteItem): Promise<void> {
  try {
    if (item.nodeType === 'folder') {
      await window.api.file.deleteExternalDir(item.trashPath)
    } else {
      await window.api.file.deleteExternalFile(item.trashPath)
    }
  } catch (error) {
    logger.warn('Failed to delete recycled note entry permanently', error as Error)
  }
}

async function cleanupExpiredEntries(state?: RecycleBinState): Promise<RecycleBinState> {
  return state ?? (await readState())
}

async function getTopicPayload(topicId: string): Promise<{ messages: Message[]; blocks: MessageBlock[] }> {
  const topicRecord = await db.topics.get(topicId)
  const messages = topicRecord?.messages || []
  const blockIds = messages.flatMap((message) => message.blocks || [])
  const blocks = blockIds.length > 0 ? await db.message_blocks.where('id').anyOf(blockIds).toArray() : []

  return { messages, blocks }
}

async function getNotesTrashRoot() {
  const appInfo = await window.api.getAppInfo()
  const trashRoot = joinPath(appInfo.appDataPath, 'recycle-bin', 'notes')
  await window.api.file.mkdir(trashRoot)
  return trashRoot
}

const mapNoteSnapshot = (node: NotesTreeNode): RecycleBinNoteNodeSnapshot | null => {
  if (node.type === 'hint') {
    return null
  }

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    children:
      node.type === 'folder'
        ? (node.children || [])
            .map((child) => mapNoteSnapshot(child))
            .filter((child): child is RecycleBinNoteNodeSnapshot => Boolean(child))
        : undefined
  }
}

const RecycleBinService = {
  async listTopics(): Promise<RecycleBinTopicItem[]> {
    const state = await cleanupExpiredEntries()
    return [...state.topics].sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime())
  },

  async listConversationFolders(): Promise<RecycleBinConversationFolderItem[]> {
    const state = await cleanupExpiredEntries()
    return [...state.conversationFolders].sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime())
  },

  async moveConversationFolderToRecycleBin(folder: ConversationFolder): Promise<void> {
    const state = await cleanupExpiredEntries()
    const deletedAt = new Date().toISOString()
    const folderTopicEntries: RecycleBinTopicItem[] = []
    const currentTopics = store.getState().assistants.assistants.flatMap((assistant) => assistant.topics || [])

    for (const topicId of folder.topicIds) {
      const topic = currentTopics.find((item) => item.id === topicId)
      if (!topic) {
        continue
      }

      const { messages, blocks } = await getTopicPayload(topic.id)
      folderTopicEntries.push({
        entryId: uuid(),
        deletedAt,
        topic,
        messages,
        blocks,
        folderId: folder.id
      })
    }

    await writeState({
      ...state,
      conversationFolders: [
        {
          entryId: uuid(),
          deletedAt,
          folder
        },
        ...state.conversationFolders.filter((item) => item.folder.id !== folder.id)
      ],
      topics: [
        ...folderTopicEntries,
        ...state.topics.filter((item) => !folder.topicIds.includes(item.topic.id))
      ]
    })

    await db.transaction('rw', [db.topics, db.message_blocks], async () => {
      for (const item of folderTopicEntries) {
        const blockIds = item.blocks.map((block) => block.id)
        if (blockIds.length > 0) {
          await db.message_blocks.bulkDelete(blockIds)
        }
        await db.topics.delete(item.topic.id)
      }
    })

    for (const item of folderTopicEntries) {
      store.dispatch(removeTopicAction({ assistantId: item.topic.assistantId, topic: item.topic }))
    }
    store.dispatch(deleteConversationFolder({ id: folder.id }))
  },

  async listNotes(): Promise<RecycleBinNoteItem[]> {
    const state = await cleanupExpiredEntries()
    return [...state.notes].sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime())
  },

  async moveTopicToRecycleBin(topic: Topic): Promise<void> {
    const state = await cleanupExpiredEntries()
    const { messages, blocks } = await getTopicPayload(topic.id)

    const nextState: RecycleBinState = {
      ...state,
      topics: [
        {
          entryId: uuid(),
          deletedAt: new Date().toISOString(),
          topic,
          messages,
          blocks,
          folderId:
            store
              .getState()
              .assistants.conversationFolders?.find((folder) => folder.topicIds.includes(topic.id))?.id || undefined
        },
        ...state.topics.filter((item) => item.topic.id !== topic.id)
      ]
    }

    await writeState(nextState)

    const blockIds = blocks.map((block) => block.id)
    await db.transaction('rw', [db.topics, db.message_blocks], async () => {
      if (blockIds.length > 0) {
        await db.message_blocks.bulkDelete(blockIds)
      }
      await db.topics.delete(topic.id)
    })
  },

  async restoreTopic(entryId: string): Promise<Topic | null> {
    const state = await cleanupExpiredEntries()
    const entry = state.topics.find((item) => item.entryId === entryId)
    if (!entry) {
      return null
    }

    const currentState = store.getState()
    const assistantIds = new Set(currentState.assistants.assistants.map((assistant) => assistant.id))
    const fallbackAssistantId = currentState.assistants.defaultAssistant.id
    const nextAssistantId = assistantIds.has(entry.topic.assistantId) ? entry.topic.assistantId : fallbackAssistantId

    const topicIdExists = currentState.assistants.assistants.some((assistant) =>
      assistant.topics?.some((topic) => topic.id === entry.topic.id)
    )
    const nextTopicId = topicIdExists ? uuid() : entry.topic.id

    const restoredMessages = entry.messages.map((message) => ({
      ...message,
      topicId: nextTopicId,
      assistantId: nextAssistantId
    }))
    const restoredBlocks = entry.blocks.map((block) => ({
      ...block,
      messageId: restoredMessages.find((message) => message.blocks.includes(block.id))?.id || block.messageId
    }))
    const restoredTopic: Topic = {
      ...entry.topic,
      id: nextTopicId,
      assistantId: nextAssistantId,
      messages: restoredMessages
    }

    await db.transaction('rw', [db.topics, db.message_blocks], async () => {
      if (restoredBlocks.length > 0) {
        await db.message_blocks.bulkPut(restoredBlocks)
      }
      await db.topics.put({ id: restoredTopic.id, messages: restoredMessages })
    })

    store.dispatch(addTopicAction({ assistantId: nextAssistantId, topic: restoredTopic }))
    if (entry.folderId) {
      store.dispatch(moveTopicToConversationFolder({ topicId: restoredTopic.id, folderId: entry.folderId }))
    }

    await writeState({
      ...state,
      topics: state.topics.filter((item) => item.entryId !== entryId)
    })

    return restoredTopic
  },

  async permanentlyDeleteTopic(entryId: string): Promise<void> {
    const state = await cleanupExpiredEntries()
    const entry = state.topics.find((item) => item.entryId === entryId)
    if (!entry) {
      return
    }

    await permanentlyDeleteTopicItem(entry)

    await writeState({
      ...state,
      topics: state.topics.filter((item) => item.entryId !== entryId)
    })
  },

  async restoreConversationFolder(entryId: string): Promise<ConversationFolder | null> {
    const state = await cleanupExpiredEntries()
    const folderEntry = state.conversationFolders.find((item) => item.entryId === entryId)
    if (!folderEntry) {
      return null
    }

    const folderExists = store.getState().assistants.conversationFolders.some((folder) => folder.id === folderEntry.folder.id)
    const nextFolderId = folderExists ? uuid() : folderEntry.folder.id

    store.dispatch(
      createConversationFolder({
        id: nextFolderId,
        name: folderEntry.folder.name
      })
    )

    const relatedTopicEntries = state.topics.filter((item) => item.folderId === folderEntry.folder.id)
    for (const item of relatedTopicEntries) {
      const restoredTopic = await this.restoreTopic(item.entryId)
      if (restoredTopic) {
        store.dispatch(moveTopicToConversationFolder({ topicId: restoredTopic.id, folderId: nextFolderId }))
      }
    }

    const latestState = await cleanupExpiredEntries()
    await writeState({
      ...latestState,
      conversationFolders: latestState.conversationFolders.filter((item) => item.entryId !== entryId)
    })

    return {
      ...folderEntry.folder,
      id: nextFolderId
    }
  },

  async permanentlyDeleteConversationFolder(entryId: string): Promise<void> {
    const state = await cleanupExpiredEntries()
    const folderEntry = state.conversationFolders.find((item) => item.entryId === entryId)
    if (!folderEntry) {
      return
    }

    const relatedTopicEntries = state.topics.filter((item) => item.folderId === folderEntry.folder.id)
    for (const item of relatedTopicEntries) {
      await permanentlyDeleteTopicItem(item)
    }

    await writeState({
      ...state,
      conversationFolders: state.conversationFolders.filter((item) => item.entryId !== entryId),
      topics: state.topics.filter((item) => item.folderId !== folderEntry.folder.id)
    })
  },

  async moveNoteToRecycleBin(node: NotesTreeNode): Promise<void> {
    if (node.type === 'hint') {
      return
    }

    const state = await cleanupExpiredEntries()
    const trashRoot = await getNotesTrashRoot()
    const originalName = getBasename(node.externalPath)
    const trashPath = joinPath(trashRoot, `${Date.now()}-${uuid()}-${originalName}`)

    if (node.type === 'folder') {
      await window.api.file.moveDir(node.externalPath, trashPath)
    } else {
      await window.api.file.move(node.externalPath, trashPath)
    }

    const entry: RecycleBinNoteItem = {
      entryId: uuid(),
      deletedAt: new Date().toISOString(),
      nodeType: node.type,
      name: node.name,
      originalPath: node.externalPath,
      trashPath,
      children:
        node.type === 'folder'
          ? (node.children || [])
              .map((child) => mapNoteSnapshot(child))
              .filter((child): child is RecycleBinNoteNodeSnapshot => Boolean(child))
          : undefined
    }

    await writeState({
      ...state,
      notes: [entry, ...state.notes]
    })
  },

  async restoreNote(entryId: string): Promise<string | null> {
    const state = await cleanupExpiredEntries()
    const entry = state.notes.find((item) => item.entryId === entryId)
    if (!entry) {
      return null
    }

    const parentDir = getDirname(entry.originalPath)
    await window.api.file.mkdir(parentDir)

    const originalBaseName = getBasename(entry.originalPath)
    const isFile = entry.nodeType === 'file'
    const { safeName } = await window.api.file.checkFileName(
      parentDir,
      isFile ? getFileNameWithoutExtension(originalBaseName) : originalBaseName,
      isFile
    )
    const restoredPath = isFile ? joinPath(parentDir, `${safeName}.md`) : joinPath(parentDir, safeName)

    if (isFile) {
      await window.api.file.move(entry.trashPath, restoredPath)
    } else {
      await window.api.file.moveDir(entry.trashPath, restoredPath)
    }

    await writeState({
      ...state,
      notes: state.notes.filter((item) => item.entryId !== entryId)
    })

    return restoredPath
  },

  async permanentlyDeleteNote(entryId: string): Promise<void> {
    const state = await cleanupExpiredEntries()
    const entry = state.notes.find((item) => item.entryId === entryId)
    if (!entry) {
      return
    }

    await permanentlyDeleteNoteItem(entry)

    await writeState({
      ...state,
      notes: state.notes.filter((item) => item.entryId !== entryId)
    })
  }
}

export default RecycleBinService
