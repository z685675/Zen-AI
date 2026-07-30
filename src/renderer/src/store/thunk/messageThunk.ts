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
import { loggerService } from '@logger'
import { AiSdkToChunkAdapter } from '@renderer/aiCore/chunk/AiSdkToChunkAdapter'
import { AgentApiClient, DEFAULT_SESSION_PAGE_SIZE } from '@renderer/api/agent'
import db from '@renderer/databases'
import { getModel } from '@renderer/hooks/useModel'
import { fetchGenerate, fetchMessagesSummary, transformMessagesAndFetch } from '@renderer/services/ApiService'
import { getAssistantSettings, getProviderByModel } from '@renderer/services/AssistantService'
import {
  clearContextCheckpoint,
  loadContextCheckpoint,
  manageStandaloneInput
} from '@renderer/services/context/ContextCompactionService'
import {
  deleteContextResources,
  deleteContextResourcesForMessages,
  formatResourceSearchContext,
  listContextResources,
  saveTextContextResource,
  searchContextResources
} from '@renderer/services/context/ContextResourceService'
import {
  clearContextTelemetry,
  markContextProcessingError,
  recordContextCompression,
  recordContextResourceCount,
  recordContextRetrieval,
  recordContextRetry,
  setContextProcessingStatus
} from '@renderer/services/context/ContextTelemetryService'
import { createContextBudget } from '@renderer/services/context/ContextWindowService'
import { dbService } from '@renderer/services/db'
import { DbService } from '@renderer/services/db/DbService'
import FileManager from '@renderer/services/FileManager'
import { BlockManager } from '@renderer/services/messageStreaming/BlockManager'
import { createCallbacks } from '@renderer/services/messageStreaming/callbacks'
import { endSpan } from '@renderer/services/SpanManagerService'
import { createStreamProcessor, type StreamProcessorCallbacks } from '@renderer/services/StreamProcessingService'
import { estimateTextTokens } from '@renderer/services/TokenService'
import store from '@renderer/store'
import { updateTopicUpdatedAt } from '@renderer/store/assistants'
import { type ApiServerConfig, type Assistant, type FileMetadata, type Model, type Topic } from '@renderer/types'
import type {
  AgentEffort,
  AgentThinkingConfig,
  GetAgentSessionResponse,
  ListAgentSessionsResponse
} from '@renderer/types/agent'
import { ChunkType } from '@renderer/types/chunk'
import type {
  AgentSessionSyncMetadata,
  FileMessageBlock,
  ImageMessageBlock,
  Message,
  MessageBlock,
  MessageProviderMetadata
} from '@renderer/types/newMessage'
import {
  AssistantMessageStatus,
  MessageBlockStatus,
  MessageBlockType,
  UserMessageStatus
} from '@renderer/types/newMessage'
import { uuid } from '@renderer/utils'
import { addAbortController } from '@renderer/utils/abortController'
import {
  buildAgentSessionTopicId,
  extractAgentSessionIdFromTopicId,
  isAgentSessionTopicId
} from '@renderer/utils/agentSession'
import {
  deriveAgentSessionFallbackTitle,
  isUnnamedAgentSessionName,
  normalizeAgentSessionTitle
} from '@renderer/utils/agentSessionTitle'
import { isAbortError } from '@renderer/utils/error'
import { resolveRetryModelSelection } from '@renderer/utils/messageRetryModel'
import {
  createAssistantMessage,
  createTranslationBlock,
  resetAssistantMessage
} from '@renderer/utils/messageUtils/create'
import { getContentWithTools, getMainTextContent } from '@renderer/utils/messageUtils/find'
import { getTopicQueue, waitForTopicQueue } from '@renderer/utils/queue'
import { IpcChannel } from '@shared/IpcChannel'
import { defaultAppHeaders } from '@shared/utils'
import type { TextStreamPart } from 'ai'
import { t } from 'i18next'
import { isEmpty, throttle } from 'lodash'
import { LRUCache } from 'lru-cache'
import { mutate } from 'swr'
import { unstable_serialize } from 'swr/infinite'

import type { AppDispatch, RootState } from '../index'
import { removeManyBlocks, updateOneBlock, upsertManyBlocks, upsertOneBlock } from '../messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '../newMessage'
// import {
//   bulkAddBlocksV2,
//   clearMessagesFromDBV2,
//   deleteMessageFromDBV2,
//   deleteMessagesFromDBV2,
//   loadTopicMessagesThunkV2,
//   saveMessageAndBlocksToDBV2,
//   updateBlocksV2,
//   updateFileCountV2,
//   updateMessageV2,
//   updateSingleBlockV2
// } from './messageThunk.v2'

const logger = loggerService.withContext('MessageThunk')

const finishTopicLoading = async (topicId: string) => {
  await waitForTopicQueue(topicId)
  store.dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
  store.dispatch(newMessagesActions.setTopicFulfilled({ topicId, fulfilled: true }))
}

const getCurrentTopicModel = (state: RootState, topicId: string, assistant: Assistant): Model => {
  const storedAssistant = state.assistants.assistants.find((item) => item.id === assistant.id)
  return storedAssistant?.topics.find((topic) => topic.id === topicId)?.model ?? assistant.model
}

type AgentSessionContext = {
  agentId: string
  sessionId: string
  agentSessionId?: string
  effort?: AgentEffort
  thinking?: AgentThinkingConfig
}

const AGENT_SESSION_RECOVERY_INSTRUCTION = [
  '【任务恢复要求】',
  '用户正在重新生成一个可能被中断过的长任务。继续前请先检查目标目录、已有文件、已有结果或当前环境状态，判断哪些部分已经完成。',
  '只继续未完成或缺失的部分，不要重复下载、重复生成或覆盖已经完成的结果，除非用户明确要求。',
  '如果无法确认完成度，请先说明当前能确认的进度，并询问是否继续补全。',
  '不要承诺“我会继续盯着”“完成后再告诉你”等后台继续执行能力；除非本次回复内已经实际完成并校验，否则不要说任务已完成。'
].join('\n')
const AGENT_SESSION_INTERRUPTED_CACHE_TTL = 1000 * 60 * 60 * 24
const AGENT_SESSION_CHANNEL_STALL_TIMEOUT_MS = 1000 * 60 * 3
const AGENT_SESSION_RENAME_MESSAGE_RETRY_DELAYS_MS = [0, 150, 500]
const AGENT_SESSION_RENAME_UPDATE_RETRY_DELAYS_MS = [0, 250]
const AGENT_RECOVERY_CONTEXT_TOKEN_BUDGET = 64_000
const AGENT_LARGE_RESULT_TOKEN_THRESHOLD = 16_000

const agentSessionRenameLocks = new Set<string>()
const dbFacade = DbService.getInstance()

const buildAgentSessionSyncMetadata = (
  status: AgentSessionSyncMetadata['status'],
  reason?: string
): AgentSessionSyncMetadata => ({
  target: 'wechat',
  status,
  updatedAt: new Date().toISOString(),
  ...(reason ? { reason } : {})
})

const withAgentSessionSyncMetadata = (
  message: Message | undefined,
  status: AgentSessionSyncMetadata['status'],
  reason?: string
): MessageProviderMetadata => ({
  ...message?.providerMetadata,
  agentSessionSync: buildAgentSessionSyncMetadata(status, reason)
})

const updateAgentSessionSyncStatus = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  messageIds: string[],
  status: AgentSessionSyncMetadata['status'],
  reason?: string
) => {
  const updates = messageIds
    .map((messageId) => {
      const message = getState().messages.entities[messageId]
      if (!message) {
        return null
      }

      const providerMetadata = withAgentSessionSyncMetadata(message, status, reason)
      return { messageId, providerMetadata }
    })
    .filter(Boolean) as Array<{ messageId: string; providerMetadata: MessageProviderMetadata }>

  if (updates.length === 0) {
    return
  }

  for (const update of updates) {
    dispatch(
      newMessagesActions.updateMessage({
        topicId,
        messageId: update.messageId,
        updates: { providerMetadata: update.providerMetadata }
      })
    )
  }

  await Promise.all(
    updates.map((update) => updateMessage(topicId, update.messageId, { providerMetadata: update.providerMetadata }))
  )
}

const finalizeStaleAssistantBlocksAfterStream = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  assistantMessageId: string
) => {
  const state = getState()
  const assistantMessage = state.messages.entities[assistantMessageId]
  if (!assistantMessage) {
    return
  }

  const staleBlocks = (assistantMessage.blocks || [])
    .map((blockId) => state.messageBlocks.entities[blockId])
    .filter(
      (block): block is MessageBlock =>
        !!block &&
        (block.status === MessageBlockStatus.PROCESSING ||
          block.status === MessageBlockStatus.STREAMING ||
          block.status === MessageBlockStatus.PENDING)
    )

  if (staleBlocks.length === 0) {
    return
  }

  const now = new Date().toISOString()
  const updatedBlocks = staleBlocks.map((block) => ({
    ...block,
    status: MessageBlockStatus.SUCCESS,
    updatedAt: now
  }))

  for (const block of updatedBlocks) {
    dispatch(
      updateOneBlock({
        id: block.id,
        changes: {
          status: MessageBlockStatus.SUCCESS,
          updatedAt: now
        }
      })
    )
  }

  const messageUpdates = {
    status: AssistantMessageStatus.SUCCESS,
    updatedAt: now
  }

  dispatch(
    newMessagesActions.updateMessage({
      topicId,
      messageId: assistantMessageId,
      updates: messageUpdates
    })
  )

  await saveUpdatesToDB(assistantMessageId, topicId, messageUpdates, updatedBlocks)
}

const isWechatBoundAgentSession = async (
  apiServer: ApiServerConfig,
  agentSession: AgentSessionContext
): Promise<boolean> => {
  if (!apiServer.enabled || !apiServer.apiKey) {
    return false
  }

  try {
    const baseURL = buildAgentBaseURL(apiServer)
    const client = new AgentApiClient({
      baseURL,
      headers: {
        Authorization: `Bearer ${apiServer.apiKey}`
      }
    })
    const channels = await client.listChannels({ agent_id: agentSession.agentId, type: 'wechat' })
    return channels.data.some((channel) => {
      const sessionId = channel?.sessionId ?? channel?.session_id
      const isActive = channel?.isActive ?? channel?.is_active
      return sessionId === agentSession.sessionId && isActive !== false
    })
  } catch (error) {
    logger.warn('Failed to check bound WeChat channel for agent session', error as Error)
    return false
  }
}

const collectMainTextContentFromBlocks = (
  message: Pick<Message, 'blocks'> | undefined,
  blocks: MessageBlock[]
): string => {
  if (!message?.blocks?.length || blocks.length === 0) {
    return ''
  }

  const blockMap = new Map(blocks.map((block) => [block.id, block]))

  return message.blocks
    .map((blockId) => blockMap.get(blockId))
    .filter(
      (block): block is Extract<MessageBlock, { type: MessageBlockType.MAIN_TEXT }> =>
        !!block && block.type === MessageBlockType.MAIN_TEXT && typeof block.content === 'string'
    )
    .map((block) => block.content)
    .join('\n\n')
}

const resolveAgentSessionUserContent = async (
  topicId: string,
  userMessageId: string,
  getState: () => RootState
): Promise<string> => {
  const userMessageEntity = getState().messages.entities[userMessageId]
  const liveContent = userMessageEntity ? getMainTextContent(userMessageEntity).trim() : ''

  if (liveContent) {
    return liveContent
  }

  try {
    const { messages, blocks } = await dbFacade.fetchMessages(topicId, true)
    const persistedUserMessage = messages.find((message) => message.id === userMessageId)
    const persistedContent = collectMainTextContentFromBlocks(persistedUserMessage, blocks).trim()

    if (persistedContent) {
      logger.warn('Recovered agent session user content from persisted history', {
        topicId,
        userMessageId
      })
      return persistedContent
    }
  } catch (error) {
    logger.warn('Failed to recover agent session user content from persisted history', {
      topicId,
      userMessageId,
      error
    })
  }

  return ''
}

type ChannelImageAttachment = {
  data: string
  media_type: string
}

const getBlocksFromStateOrDB = async (
  topicId: string,
  message: Pick<Message, 'id' | 'blocks'>,
  getState: () => RootState
): Promise<MessageBlock[]> => {
  const liveBlocks = (message.blocks || [])
    .map((blockId) => getState().messageBlocks.entities[blockId])
    .filter(Boolean) as MessageBlock[]

  if (liveBlocks.length > 0) {
    return liveBlocks
  }

  try {
    const { blocks } = await dbFacade.fetchMessages(topicId, true)
    const blockIdSet = new Set(message.blocks || [])
    return blocks.filter((block) => blockIdSet.has(block.id))
  } catch (error) {
    logger.warn('Failed to recover message blocks from persisted history', {
      topicId,
      messageId: message.id,
      error
    })
    return []
  }
}

const resolveAgentSessionChannelAttachments = async (
  topicId: string,
  userMessage: Message,
  getState: () => RootState
): Promise<{ imagePaths: string[] }> => {
  const blocks = await getBlocksFromStateOrDB(topicId, userMessage, getState)
  const imagePaths: string[] = []

  for (const block of blocks) {
    if (block.type !== MessageBlockType.IMAGE) {
      continue
    }

    const metadata = block.metadata as
      | {
          channelImagePath?: string
        }
      | undefined

    if (metadata?.channelImagePath) {
      imagePaths.push(metadata.channelImagePath)
    }
  }

  return { imagePaths }
}

const hasPausedOrCancelledAgentSessionBlocks = (state: RootState, assistantMessages: Message[]): boolean => {
  for (const message of assistantMessages) {
    for (const blockId of message.blocks || []) {
      const block = state.messageBlocks.entities[blockId]
      if (!block) continue

      if (block.status === MessageBlockStatus.PAUSED) {
        return true
      }

      if (block.type === MessageBlockType.TOOL && block.metadata?.rawMcpToolResponse?.status === 'cancelled') {
        return true
      }
    }
  }

  return false
}

const wasAgentSessionRecentlyInterrupted = (userMessageId: string): boolean => {
  const interruptedAt = Number(window.keyv.get(`agent-session-interrupted-${userMessageId}`) || 0)
  if (!interruptedAt) {
    return false
  }

  if (Date.now() - interruptedAt > AGENT_SESSION_INTERRUPTED_CACHE_TTL) {
    window.keyv.remove(`agent-session-interrupted-${userMessageId}`)
    return false
  }

  return true
}

const withAgentSessionRecoveryInstruction = (content: string): string => {
  const trimmedContent = content.trim()
  if (!trimmedContent) {
    return trimmedContent
  }

  return `${trimmedContent}\n\n${AGENT_SESSION_RECOVERY_INSTRUCTION}`
}

const withChannelImagePathInstruction = (content: string, imagePaths: string[]): string => {
  const uniquePaths = [...new Set(imagePaths.map((path) => path.trim()).filter(Boolean))]
  if (uniquePaths.length === 0) {
    return content
  }

  return [
    content.trim(),
    '',
    '[Attached images saved to workspace]',
    ...uniquePaths.map((path) => `- ${path}`),
    '',
    '请根据上面的本地图片路径读取并理解图片内容。'
  ].join('\n')
}

const findExistingAgentSessionContext = (
  state: RootState,
  topicId: string,
  assistantId: string
): AgentSessionContext | undefined => {
  if (!isAgentSessionTopicId(topicId)) {
    return undefined
  }

  const sessionId = extractAgentSessionIdFromTopicId(topicId)
  if (!sessionId) {
    return undefined
  }

  const messageIds = state.messages.messageIdsByTopic[topicId]
  let existingAgentSessionId: string | undefined

  if (messageIds?.length) {
    for (let index = messageIds.length - 1; index >= 0; index -= 1) {
      const messageId = messageIds[index]
      const message = state.messages.entities[messageId]
      const candidate = message?.agentSessionId?.trim()

      if (!candidate) {
        continue
      }

      if (message.assistantId !== assistantId) {
        continue
      }

      existingAgentSessionId = candidate
      break
    }
  }

  return {
    agentId: assistantId,
    sessionId,
    agentSessionId: existingAgentSessionId
  }
}

const runAgentSessionResend = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  userMessageToResend: Message,
  assistant: Assistant
) => {
  const agentSession = findExistingAgentSessionContext(getState(), topicId, assistant.id)
  if (!agentSession) {
    throw new Error(`Agent session context not found for topic: ${topicId}`)
  }

  const state = getState()
  const allMessagesForTopic = selectMessagesForTopic(state, topicId)
  const assistantMessagesToReset = allMessagesForTopic.filter(
    (m) => m.askId === userMessageToResend.id && m.role === 'assistant'
  )
  const recoveryMode =
    wasAgentSessionRecentlyInterrupted(userMessageToResend.id) ||
    hasPausedOrCancelledAgentSessionBlocks(state, assistantMessagesToReset)

  const allBlockIdsToDelete: string[] = []
  const resetMessages: Message[] = []

  for (const originalMsg of assistantMessagesToReset) {
    const blockIdsToDelete = [...(originalMsg.blocks || [])]
    const resetMsg = resetAssistantMessage(originalMsg, {
      status: AssistantMessageStatus.PENDING,
      updatedAt: new Date().toISOString(),
      model: originalMsg.model ?? assistant.model
    })

    if (agentSession.agentSessionId && !resetMsg.agentSessionId) {
      resetMsg.agentSessionId = agentSession.agentSessionId
    }

    resetMessages.push(resetMsg)
    allBlockIdsToDelete.push(...blockIdsToDelete)

    dispatch(
      newMessagesActions.updateMessage({
        topicId,
        messageId: resetMsg.id,
        updates: resetMsg
      })
    )
  }

  if (assistantMessagesToReset.length === 0) {
    const assistantMessage = createAssistantMessage(assistant.id, topicId, {
      askId: userMessageToResend.id,
      model: assistant.model,
      traceId: userMessageToResend.traceId
    })

    if (agentSession.agentSessionId && !assistantMessage.agentSessionId) {
      assistantMessage.agentSessionId = agentSession.agentSessionId
    }

    resetMessages.push(assistantMessage)
    await saveMessageAndBlocksToDB(topicId, assistantMessage, [])
    dispatch(newMessagesActions.addMessage({ topicId, message: assistantMessage }))
  } else {
    cleanupMultipleBlocks(dispatch, allBlockIdsToDelete)

    try {
      if (allBlockIdsToDelete.length > 0) {
        await db.message_blocks.bulkDelete(allBlockIdsToDelete)
      }
      const finalMessagesToSave = selectMessagesForTopic(getState(), topicId)
      await db.topics.update(topicId, { messages: finalMessagesToSave })
    } catch (dbError) {
      logger.error('[runAgentSessionResend] Error updating database:', dbError as Error)
    }
  }

  const queue = getTopicQueue(topicId)
  for (const resetMsg of resetMessages) {
    const assistantConfigForThisRegen = {
      ...assistant,
      ...(resetMsg.model ? { model: resetMsg.model } : {})
    }

    void queue.add(async () => {
      await fetchAndProcessAgentResponseImpl(dispatch, getState, {
        topicId,
        assistant: assistantConfigForThisRegen,
        assistantMessage: resetMsg,
        agentSession,
        userMessageId: userMessageToResend.id,
        recoveryMode
      })
    })
  }
}

const buildAgentBaseURL = (apiServer: ApiServerConfig) => {
  const hasProtocol = apiServer.host.startsWith('http://') || apiServer.host.startsWith('https://')
  const baseHost = hasProtocol ? apiServer.host : `http://${apiServer.host}`
  const portSegment = apiServer.port ? `:${apiServer.port}` : ''
  return `${baseHost}${portSegment}`
}

export const renameAgentSessionIfNeeded = async (
  agentSession: AgentSessionContext,
  topicId: string,
  getState: () => RootState,
  options: {
    force?: boolean
    preferGeneratedTitle?: boolean
  } = {}
): Promise<boolean> => {
  const lockId = `${agentSession.agentId}:${agentSession.sessionId}`
  if (agentSessionRenameLocks.has(lockId)) {
    return false
  }

  agentSessionRenameLocks.add(lockId)

  try {
    const state = getState()
    const apiServer = state.settings.apiServer
    if (!apiServer?.apiKey) {
      return false
    }

    const baseURL = buildAgentBaseURL(apiServer)
    const client = new AgentApiClient({
      baseURL,
      headers: {
        Authorization: `Bearer ${apiServer.apiKey}`
      }
    })

    let session: GetAgentSessionResponse
    try {
      session = await client.getSession(agentSession.agentId, agentSession.sessionId)
    } catch (error) {
      logger.warn('Failed to fetch agent session for rename', error as Error)
      return false
    }

    const currentName = (session.name ?? '').trim()
    if (!options.force && !isUnnamedAgentSessionName(currentName, t('common.unnamed'))) {
      return false
    }

    const liveState = getState()
    const liveMessages = selectMessagesForTopic(liveState, topicId)
    const liveBlocks = liveMessages.flatMap((message) =>
      message.blocks
        .map((blockId) => liveState.messageBlocks.entities[blockId])
        .filter((block): block is MessageBlock => !!block)
    )

    let namingMessages = liveMessages
    let namingBlocks = liveBlocks
    let fallbackTitle = deriveAgentSessionFallbackTitle({
      messages: namingMessages,
      blocks: namingBlocks
    })

    if (!fallbackTitle) {
      for (const delayMs of AGENT_SESSION_RENAME_MESSAGE_RETRY_DELAYS_MS) {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }

        try {
          const persisted = await dbFacade.fetchMessages(topicId, true)
          namingMessages = persisted.messages
          namingBlocks = persisted.blocks
          fallbackTitle = deriveAgentSessionFallbackTitle({
            messages: namingMessages,
            blocks: namingBlocks
          })
          if (fallbackTitle) {
            break
          }
        } catch (error) {
          logger.debug('Agent session messages are not ready for rename yet', {
            sessionId: agentSession.sessionId,
            error
          })
        }
      }
    }

    fallbackTitle ??= deriveAgentSessionFallbackTitle({
      messages: namingMessages,
      blocks: namingBlocks,
      genericTitle: t('agent.session.fallback_title')
    })

    if (!fallbackTitle) {
      return false
    }

    const paths = client.getSessionPaths(agentSession.agentId)
    const sessionListKey = unstable_serialize(() => [paths.base, 0, DEFAULT_SESSION_PAGE_SIZE])
    const allSessionListKeys = (['exclude', 'include', 'only'] as const).map((archived) =>
      unstable_serialize(() => [client.allSessionsPath, archived, 0, DEFAULT_SESSION_PAGE_SIZE])
    )

    const updateSessionCaches = async (renamedSession: GetAgentSessionResponse) => {
      const updateSessionInPages = (pages: ListAgentSessionsResponse[] | undefined) =>
        pages?.map((page) => ({
          ...page,
          data: page.data.map((sessionItem) =>
            sessionItem.id === renamedSession.id ? { ...sessionItem, ...renamedSession } : sessionItem
          )
        })) ?? pages

      try {
        await Promise.all([
          mutate(paths.withId(agentSession.sessionId), renamedSession, { revalidate: false }),
          mutate<ListAgentSessionsResponse[]>(sessionListKey, updateSessionInPages, { revalidate: false }),
          ...allSessionListKeys.map((key) =>
            mutate<ListAgentSessionsResponse[]>(key, updateSessionInPages, { revalidate: false })
          )
        ])
      } catch (error) {
        logger.warn('Failed to update agent session cache after rename', error as Error)
      }
    }

    const updateSessionName = async (nextName: string): Promise<GetAgentSessionResponse | null> => {
      for (const delayMs of AGENT_SESSION_RENAME_UPDATE_RETRY_DELAYS_MS) {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }

        try {
          const renamedSession = await client.updateSession(agentSession.agentId, {
            id: agentSession.sessionId,
            name: nextName
          })
          await updateSessionCaches(renamedSession)
          return renamedSession
        } catch (error) {
          logger.warn('Failed to update agent session name', error as Error)
        }
      }

      return null
    }

    let fallbackSession: GetAgentSessionResponse | null = null
    if (!options.force) {
      let latestSession: GetAgentSessionResponse
      try {
        latestSession = await client.getSession(agentSession.agentId, agentSession.sessionId)
      } catch (error) {
        logger.warn('Failed to recheck agent session before fallback rename', error as Error)
        return false
      }

      const latestName = (latestSession.name ?? '').trim()
      if (!isUnnamedAgentSessionName(latestName, t('common.unnamed'))) {
        return false
      }

      fallbackSession = await updateSessionName(fallbackTitle)
    }

    let generatedTitle: string | null = null
    const shouldGenerateTitle =
      options.preferGeneratedTitle !== false && getState().settings.enableTopicNaming && liveMessages.length > 0

    if (shouldGenerateTitle) {
      try {
        const { text: summary, error } = await fetchMessagesSummary({ messages: liveMessages })
        generatedTitle = summary ? normalizeAgentSessionTitle(summary) : null
        if (!generatedTitle && error) {
          logger.debug('Keeping local agent session title after summary failed', {
            sessionId: agentSession.sessionId,
            error
          })
        }
      } catch (error) {
        logger.debug('Keeping local agent session title after summary threw', {
          sessionId: agentSession.sessionId,
          error
        })
      }
    }

    const nextName =
      generatedTitle && !isUnnamedAgentSessionName(generatedTitle, t('common.unnamed')) ? generatedTitle : fallbackTitle

    if (!options.force && fallbackSession && nextName === fallbackTitle) {
      return true
    }

    let latestSession: GetAgentSessionResponse
    try {
      latestSession = await client.getSession(agentSession.agentId, agentSession.sessionId)
    } catch (error) {
      logger.warn('Failed to recheck agent session before final rename', error as Error)
      return !!fallbackSession
    }

    const latestName = (latestSession.name ?? '').trim()
    if (latestName === nextName) {
      return !!fallbackSession
    }

    const nameChangedDuringRename = options.force
      ? latestName !== currentName
      : !isUnnamedAgentSessionName(latestName, t('common.unnamed')) && latestName !== fallbackTitle
    if (nameChangedDuringRename) {
      return !!fallbackSession
    }

    const finalSession = await updateSessionName(nextName)
    return !!fallbackSession || !!finalSession
  } catch (error) {
    logger.warn('Unexpected error during agent session rename', error as Error)
    return false
  } finally {
    agentSessionRenameLocks.delete(lockId)
  }
}

const createSSEReadableStream = (
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal
): ReadableStream<TextStreamPart<Record<string, any>>> => {
  return new ReadableStream<TextStreamPart<Record<string, any>>>({
    start(controller) {
      const reader = source.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      const cancelReader = (reason?: any) => reader.cancel(reason).catch(() => {})

      const abortHandler = () => {
        void cancelReader(signal.reason ?? 'aborted')
        controller.error(new DOMException('Aborted', 'AbortError'))
      }

      if (signal.aborted) {
        abortHandler()
        return
      }

      signal.addEventListener('abort', abortHandler, { once: true })

      const emitEvent = (eventString: string): boolean => {
        const lines = eventString.split(/\r?\n/)
        let dataPayload = ''
        for (const line of lines) {
          if (line.startsWith('data:')) {
            dataPayload += line.slice(5).trimStart()
          }
        }

        if (!dataPayload) {
          return false
        }

        if (dataPayload === '[DONE]') {
          signal.removeEventListener('abort', abortHandler)
          void cancelReader()
          controller.close()
          return true
        }

        try {
          const parsed = JSON.parse(dataPayload) as TextStreamPart<Record<string, any>>
          controller.enqueue(parsed)
        } catch (error) {
          logger.warn('Failed to parse agent SSE chunk', { dataPayload })
        }
        return false
      }

      const pump = async () => {
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            let separatorIndex = buffer.indexOf('\n\n')
            while (separatorIndex !== -1) {
              const rawEvent = buffer.slice(0, separatorIndex).trim()
              buffer = buffer.slice(separatorIndex + 2)
              if (rawEvent) {
                const shouldStop = emitEvent(rawEvent)
                if (shouldStop) {
                  return
                }
              }
              separatorIndex = buffer.indexOf('\n\n')
            }
          }

          buffer += decoder.decode()
          if (buffer.trim()) {
            emitEvent(buffer.trim())
          }
          signal.removeEventListener('abort', abortHandler)
          controller.close()
        } catch (error) {
          signal.removeEventListener('abort', abortHandler)
          controller.error(error)
        }
      }

      pump().catch((error) => {
        signal.removeEventListener('abort', abortHandler)
        controller.error(error)
      })
    },
    cancel(reason) {
      return source.cancel(reason).catch(() => {})
    }
  })
}

/**
 * Wraps a parsed stream with abort-signal lifecycle handling.
 * In the normal chat pipeline the AI SDK runtime converts abort signals into
 * `{ type: 'abort' }` stream parts. The agent pipeline bypasses the AI SDK
 * runtime, so this middleware fills that gap — keeping the SSE parser
 * (transport) and the chunk adapter (protocol) free of lifecycle concerns.
 */
const withAbortStreamPart = (
  source: ReadableStream<TextStreamPart<Record<string, any>>>,
  signal: AbortSignal
): ReadableStream<TextStreamPart<Record<string, any>>> => {
  const reader = source.getReader()

  return new ReadableStream<TextStreamPart<Record<string, any>>>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        // When the source errors due to abort, emit the abort stream part
        // so downstream consumers (AiSdkToChunkAdapter) can fire onError.
        if (signal.aborted) {
          try {
            controller.enqueue({ type: 'abort' } as TextStreamPart<Record<string, any>>)
          } catch {
            // Controller may already be closed
          }
          controller.close()
        } else {
          controller.error(error)
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    }
  })
}

const createAgentMessageStream = async (
  apiServer: ApiServerConfig,
  agentSession: AgentSessionContext,
  content: string,
  recoveryContext: string | undefined,
  signal: AbortSignal
): Promise<ReadableStream<TextStreamPart<Record<string, any>>>> => {
  if (!apiServer.enabled) {
    throw new Error('Agent API server is disabled')
  }

  const baseURL = buildAgentBaseURL(apiServer)
  const url = `${baseURL}/v1/agents/${agentSession.agentId}/sessions/${agentSession.sessionId}/messages`
  const normalizedContent = typeof content === 'string' ? content.trim() : String(content ?? '').trim()

  if (!normalizedContent) {
    throw new Error('Unable to resend agent session message because the original user content is empty.')
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiServer.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache'
    },
    body: JSON.stringify({
      content: normalizedContent,
      ...(agentSession.effort ? { effort: agentSession.effort } : {}),
      ...(agentSession.thinking ? { thinking: agentSession.thinking } : {}),
      ...(recoveryContext ? { recovery_context: recoveryContext } : {})
    }),
    signal
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || `Failed to stream agent message: ${response.status}`)
  }

  if (!response.body) {
    throw new Error('Agent message stream has no body')
  }

  const sseStream = createSSEReadableStream(response.body, signal)
  return withAbortStreamPart(sseStream, signal)
}

const buildAgentRecoveryContext = (
  topicId: string,
  currentUserMessageId: string,
  state: RootState
): string | undefined => {
  const messages = selectMessagesForTopic(state, topicId).filter(
    (message) =>
      message.id !== currentUserMessageId &&
      (message.role === 'user' || message.role === 'assistant') &&
      getContentWithTools(message).trim()
  )
  if (messages.length === 0) {
    return undefined
  }

  const checkpoint = loadContextCheckpoint(topicId)
  const checkpointBoundary = checkpoint
    ? messages.findIndex((message) => message.id === checkpoint.includedThroughMessageId)
    : -1
  const recentMessages = checkpointBoundary >= 0 ? messages.slice(checkpointBoundary + 1) : messages
  const selectedRecent: Message[] = []
  let selectedTokens = checkpoint ? estimateTextTokens(checkpoint.summary) : 0

  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const text = getContentWithTools(recentMessages[index]).trim()
    const tokens = estimateTextTokens(text)
    if (selectedRecent.length > 0 && selectedTokens + tokens > AGENT_RECOVERY_CONTEXT_TOKEN_BUDGET) {
      break
    }
    selectedRecent.unshift(recentMessages[index])
    selectedTokens += tokens
  }

  const sections: string[] = []
  if (checkpoint) {
    sections.push(`<conversation-checkpoint>\n${checkpoint.summary}\n</conversation-checkpoint>`)
  } else if (selectedRecent.length < recentMessages.length) {
    const firstMessages = recentMessages.slice(0, 2).filter((message) => !selectedRecent.includes(message))
    if (firstMessages.length > 0) {
      sections.push(
        `<conversation-opening>\n${firstMessages
          .map(
            (message) =>
              `<message role="${message.role}" id="${message.id}">\n${getContentWithTools(message).trim()}\n</message>`
          )
          .join('\n\n')}\n</conversation-opening>`
      )
    }
    sections.push(
      '[Some middle turns were omitted from this recovery payload; exact details remain in local resources.]'
    )
  }

  sections.push(
    `<recent-transcript>\n${selectedRecent
      .map(
        (message) =>
          `<message role="${message.role}" id="${message.id}">\n${getContentWithTools(message).trim()}\n</message>`
      )
      .join('\n\n')}\n</recent-transcript>`
  )
  return sections.join('\n\n').slice(0, 240_000)
}
// TODO: 后续可以将db操作移到Listener Middleware中
// export const saveMessageAndBlocksToDB = async (message: Message, blocks: MessageBlock[], messageIndex: number = -1) => {
//   return saveMessageAndBlocksToDBV2(message.topicId, message, blocks, messageIndex)
// }

const updateExistingMessageAndBlocksInDB = async (
  updatedMessage: Partial<Message> & Pick<Message, 'id' | 'topicId'>,
  updatedBlocks: MessageBlock[]
) => {
  try {
    // Always update blocks if provided
    if (updatedBlocks.length > 0) {
      await updateBlocks(updatedBlocks)
    }

    // Check if there are message properties to update beyond id and topicId
    const messageKeysToUpdate = Object.keys(updatedMessage).filter((key) => key !== 'id' && key !== 'topicId')

    if (messageKeysToUpdate.length > 0) {
      const messageUpdatesPayload = messageKeysToUpdate.reduce<Partial<Message>>((acc, key) => {
        acc[key] = updatedMessage[key]
        return acc
      }, {})

      await updateMessage(updatedMessage.topicId, updatedMessage.id, messageUpdatesPayload)

      store.dispatch(updateTopicUpdatedAt({ topicId: updatedMessage.topicId }))
    }
  } catch (error) {
    logger.error(`[updateExistingMsg] Failed to update message ${updatedMessage.id}:`, error as Error)
  }
}

/**
 * 消息块节流器。
 * 每个消息块有独立节流器，并发更新时不会互相影响
 */
const blockUpdateThrottlers = new LRUCache<string, ReturnType<typeof throttle>>({
  max: 100,
  ttl: 1000 * 60 * 5,
  updateAgeOnGet: true,
  dispose: (throttler, id) => {
    throttler.cancel()
    const rafId = blockUpdateRafs.get(id)
    if (rafId) {
      cancelAnimationFrame(rafId)
      blockUpdateRafs.delete(id)
    }
  }
})

/**
 * 消息块 RAF 缓存。
 * 用于管理 RAF 请求创建和取消。
 */
const blockUpdateRafs = new LRUCache<string, number>({
  max: 100,
  ttl: 1000 * 60 * 5,
  updateAgeOnGet: true,
  dispose: (rafId) => {
    cancelAnimationFrame(rafId)
  }
})

/**
 * 获取或创建消息块专用的节流函数。
 */
const getBlockThrottler = (id: string) => {
  if (!blockUpdateThrottlers.has(id)) {
    const throttler = throttle(async (blockUpdate: any) => {
      const existingRAF = blockUpdateRafs.get(id)
      if (existingRAF) {
        cancelAnimationFrame(existingRAF)
      }

      const rafId = requestAnimationFrame(() => {
        store.dispatch(updateOneBlock({ id, changes: blockUpdate }))
        blockUpdateRafs.delete(id)
      })

      blockUpdateRafs.set(id, rafId)
      await updateSingleBlock(id, blockUpdate)
    }, 150)

    blockUpdateThrottlers.set(id, throttler)
  }

  return blockUpdateThrottlers.get(id)!
}

/**
 * 更新单个消息块。
 */
export const throttledBlockUpdate = (id: string, blockUpdate: any) => {
  const throttler = getBlockThrottler(id)
  // store.dispatch(updateOneBlock({ id, changes: blockUpdate }))
  throttler(blockUpdate)
}

/**
 * 取消单个块的节流更新，移除节流器和 RAF。
 */
export const cancelThrottledBlockUpdate = (id: string) => {
  const rafId = blockUpdateRafs.get(id)
  if (rafId) {
    cancelAnimationFrame(rafId)
    blockUpdateRafs.delete(id)
  }

  const throttler = blockUpdateThrottlers.get(id)
  if (throttler) {
    throttler.cancel()
    blockUpdateThrottlers.delete(id)
  }
}

/**
 * 批量清理多个消息块。
 */
export const cleanupMultipleBlocks = (dispatch: AppDispatch, blockIds: string[]) => {
  blockIds.forEach((id) => {
    cancelThrottledBlockUpdate(id)
  })

  const getBlocksFiles = async (blockIds: string[]) => {
    const blocks = await db.message_blocks.where('id').anyOf(blockIds).toArray()
    const files = blocks
      .filter((block) => block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE)
      .map((block) => block.file)
      .filter((file): file is FileMetadata => file !== undefined)
    return isEmpty(files) ? [] : files
  }

  const cleanupFiles = async (files: FileMetadata[]) => {
    await Promise.all(files.map((file) => FileManager.deleteFile(file.id, false)))
  }

  void getBlocksFiles(blockIds).then(cleanupFiles)

  if (blockIds.length > 0) {
    dispatch(removeManyBlocks(blockIds))
  }
}

// 新增: 通用的、非节流的函数，用于保存消息和块的更新到数据库
const saveUpdatesToDB = async (
  messageId: string,
  topicId: string,
  messageUpdates: Partial<Message>, // 需要更新的消息字段
  blocksToUpdate: MessageBlock[] // 需要更新/创建的块
) => {
  try {
    const messageDataToSave: Partial<Message> & Pick<Message, 'id' | 'topicId'> = {
      id: messageId,
      topicId,
      ...messageUpdates
    }
    await updateExistingMessageAndBlocksInDB(messageDataToSave, blocksToUpdate)
  } catch (error) {
    logger.error(`[DB Save Updates] Failed for message ${messageId}:`, error as Error)
  }
}

// 新增: 辅助函数，用于获取并保存单个更新后的 Block 到数据库
const saveUpdatedBlockToDB = async (
  blockId: string | null,
  messageId: string,
  topicId: string,
  getState: () => RootState
) => {
  if (!blockId) {
    logger.warn('[DB Save Single Block] Received null/undefined blockId. Skipping save.')
    return
  }
  const state = getState()
  const blockToSave = state.messageBlocks.entities[blockId]
  if (blockToSave) {
    await saveUpdatesToDB(messageId, topicId, {}, [blockToSave]) // Pass messageId, topicId, empty message updates, and the block
  } else {
    logger.warn(`[DB Save Single Block] Block ${blockId} not found in state. Cannot save.`)
  }
}

interface AgentStreamParams {
  topicId: string
  assistant: Assistant
  assistantMessage: Message
  agentSession: AgentSessionContext
  userMessageId: string
  recoveryMode?: boolean
}

const fetchAndProcessAgentResponseImpl = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  { topicId, assistant, assistantMessage, agentSession, userMessageId, recoveryMode }: AgentStreamParams
) => {
  let callbacks: StreamProcessorCallbacks = {}
  let shouldShowWechatSync = false
  let completedSuccessfully = false
  const syncMessageIds = [userMessageId, assistantMessage.id]
  try {
    dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))

    const blockManager = new BlockManager({
      dispatch,
      getState,
      saveUpdatedBlockToDB,
      saveUpdatesToDB,
      assistantMsgId: assistantMessage.id,
      topicId,
      throttledBlockUpdate,
      cancelThrottledBlockUpdate
    })

    callbacks = createCallbacks({
      blockManager,
      dispatch,
      getState,
      topicId,
      assistantMsgId: assistantMessage.id,
      saveUpdatesToDB,
      assistant
    })

    const streamProcessorCallbacks = createStreamProcessor(callbacks)

    // Emit initial chunk to mirror assistant behaviour and ensure pending UI state
    await streamProcessorCallbacks({ type: ChunkType.LLM_RESPONSE_CREATED })

    const userMessage = getState().messages.entities[userMessageId]
    const userContent = await resolveAgentSessionUserContent(topicId, userMessageId, getState)
    const channelAttachments = userMessage
      ? await resolveAgentSessionChannelAttachments(topicId, userMessage, getState)
      : { imagePaths: [] }
    const contentWithChannelAttachments = withChannelImagePathInstruction(userContent, channelAttachments.imagePaths)
    const rawRequestContent = recoveryMode
      ? withAgentSessionRecoveryInstruction(contentWithChannelAttachments)
      : contentWithChannelAttachments

    const abortController = new AbortController()
    addAbortController(userMessageId, () => abortController.abort())
    const model = assistant.model
    const contextBudget = model
      ? createContextBudget({
          model,
          provider: getProviderByModel(model),
          fixedInputTokens: 24_000,
          requestedOutputTokens: getAssistantSettings(assistant).maxTokens
        })
      : undefined
    let inputWithResources = rawRequestContent

    if (contextBudget && estimateTextTokens(rawRequestContent) <= contextBudget.compactionTriggerTokens) {
      try {
        setContextProcessingStatus(topicId, 'retrieving', '正在召回智能助手相关资料')
        const resourceResults = await searchContextResources({
          conversationId: topicId,
          query: rawRequestContent.slice(0, 8_000),
          tokenBudget: Math.min(12_000, Math.max(0, contextBudget.safeInputTokens - 1_000))
        })
        recordContextRetrieval(topicId, resourceResults.length)
        const resourceContext = formatResourceSearchContext(resourceResults)
        if (resourceContext) {
          inputWithResources = `${resourceContext}\n\n<current-user-request>\n${rawRequestContent}\n</current-user-request>`
        }
      } catch (error) {
        logger.warn('Failed to retrieve Agent context resources', error as Error)
      }
    }

    const managedInput = model
      ? await manageStandaloneInput({
          content: inputWithResources,
          budget: contextBudget!,
          sourceLabel: 'current Agent input',
          generate: (prompt, content) =>
            fetchGenerate({
              prompt,
              content,
              model,
              signal: abortController.signal,
              maxOutputTokens: Math.min(8_000, model.maxOutputTokens ?? 8_000)
            })
        })
      : {
          content: rawRequestContent,
          action: 'full' as const,
          usageBeforeTokens: 0,
          usageAfterTokens: 0
        }
    const requestContent = managedInput.content

    if (managedInput.action !== 'full') {
      recordContextCompression(topicId, managedInput.action)
      try {
        await saveTextContextResource({
          conversationId: topicId,
          sourceMessageId: userMessageId,
          sourceName: `agent-input-${userMessageId}`,
          text: rawRequestContent,
          kind: 'text',
          metadata: { agentId: agentSession.agentId, sessionId: agentSession.sessionId }
        })
      } catch (error) {
        logger.warn('Failed to persist oversized Agent input as a context resource', error as Error)
      }
      logger.info('Agent input context plan applied', {
        topicId,
        action: managedInput.action,
        usageBeforeTokens: managedInput.usageBeforeTokens,
        usageAfterTokens: managedInput.usageAfterTokens
      })
    }

    const state = getState()
    const recoveryContext = buildAgentRecoveryContext(topicId, userMessageId, state)
    const originalContextOnRawData = callbacks.onRawData
    callbacks.onRawData = async (content, metadata) => {
      await originalContextOnRawData?.(content, metadata)
      if (
        typeof content === 'object' &&
        content !== null &&
        (content as { type?: string }).type === 'context_recovery'
      ) {
        recordContextRetry(topicId, 'agent-session-recovery')
        setContextProcessingStatus(topicId, 'retrying', '运行会话已失效，正在从本地上下文恢复')
      }
    }
    const hasExistingWechatSync = syncMessageIds.some(
      (messageId) => state.messages.entities[messageId]?.providerMetadata?.agentSessionSync?.target === 'wechat'
    )
    shouldShowWechatSync =
      hasExistingWechatSync || (await isWechatBoundAgentSession(state.settings.apiServer, agentSession))
    let agentSessionSyncResolved = false

    if (shouldShowWechatSync) {
      await updateAgentSessionSyncStatus(dispatch, getState, topicId, syncMessageIds, 'pending')
      const originalOnRawData = callbacks.onRawData
      callbacks.onRawData = async (content, metadata) => {
        await originalOnRawData?.(content, metadata)

        if (
          typeof content === 'object' &&
          content !== null &&
          (content as { type?: string }).type === 'agent_session_sync'
        ) {
          const syncEvent = content as {
            target?: string
            status?: 'synced' | 'failed' | 'skipped'
            reason?: string
          }

          if (syncEvent.target !== 'wechat' || syncEvent.status === 'skipped') {
            return
          }

          agentSessionSyncResolved = true
          void updateAgentSessionSyncStatus(
            dispatch,
            getState,
            topicId,
            syncMessageIds,
            syncEvent.status === 'synced' ? 'synced' : 'failed',
            syncEvent.reason
          )
        }
      }
    }

    const stream = await createAgentMessageStream(
      state.settings.apiServer,
      agentSession,
      requestContent,
      recoveryContext,
      abortController.signal
    )

    // Store the previous session ID to detect /clear command
    let latestAgentSessionId = agentSession.agentSessionId || ''
    let sessionWasCleared = false

    const persistAgentSessionId = async (sessionId: string) => {
      if (!sessionId || sessionId === latestAgentSessionId) {
        return
      }

      // Only mark as cleared if there was a previous session ID (not initial assignment)
      sessionWasCleared = !!latestAgentSessionId

      latestAgentSessionId = sessionId
      agentSession.agentSessionId = sessionId

      if (sessionWasCleared) {
        clearContextCheckpoint(topicId)
        try {
          await deleteContextResources(topicId)
        } catch (error) {
          logger.warn('Failed to clear Agent context resources after session reset', error as Error)
        }
        clearContextTelemetry(topicId)
      }

      logger.debug(`Agent session ID updated`, {
        topicId,
        assistantMessageId: assistantMessage.id,
        value: sessionId
      })

      try {
        const stateAfterUpdate = getState()
        const assistantInState = stateAfterUpdate.messages.entities[assistantMessage.id]
        const userInState = stateAfterUpdate.messages.entities[userMessageId]

        const persistTasks: Promise<void>[] = []

        if (assistantInState?.agentSessionId !== sessionId) {
          dispatch(
            newMessagesActions.updateMessage({
              topicId,
              messageId: assistantMessage.id,
              updates: { agentSessionId: sessionId }
            })
          )
          persistTasks.push(saveUpdatesToDB(assistantMessage.id, topicId, { agentSessionId: sessionId }, []))
        }

        if (userInState && userInState.agentSessionId !== sessionId) {
          dispatch(
            newMessagesActions.updateMessage({
              topicId,
              messageId: userMessageId,
              updates: { agentSessionId: sessionId }
            })
          )
          persistTasks.push(saveUpdatesToDB(userMessageId, topicId, { agentSessionId: sessionId }, []))
        }

        if (persistTasks.length > 0) {
          await Promise.all(persistTasks)
        }

        // Refresh session data to get updated slash_commands from backend
        // This happens after the SDK init message updates the session in the database
        const apiServer = stateAfterUpdate.settings.apiServer
        if (apiServer?.apiKey) {
          const baseURL = buildAgentBaseURL(apiServer)
          const client = new AgentApiClient({
            baseURL,
            headers: {
              Authorization: `Bearer ${apiServer.apiKey}`
            }
          })
          const paths = client.getSessionPaths(agentSession.agentId)
          await mutate(paths.withId(agentSession.sessionId))
          logger.info('Refreshed session data after sessionId update', {
            agentId: agentSession.agentId,
            sessionId: agentSession.sessionId
          })
        }
      } catch (error) {
        logger.error('Failed to persist agent session ID during stream', error as Error)
      }
    }

    const adapter = new AiSdkToChunkAdapter(
      streamProcessorCallbacks,
      [],
      false,
      false,
      (sessionId) => {
        void persistAgentSessionId(sessionId)
      },
      () => sessionWasCleared // Provide getter for session cleared flag
    )

    await adapter.processStream({
      fullStream: stream,
      text: Promise.resolve('')
    })
    await finalizeStaleAssistantBlocksAfterStream(dispatch, getState, topicId, assistantMessage.id)

    const completedAssistantMessage = getState().messages.entities[assistantMessage.id]
    const completedContent = completedAssistantMessage ? getContentWithTools(completedAssistantMessage).trim() : ''
    if (completedContent && estimateTextTokens(completedContent) >= AGENT_LARGE_RESULT_TOKEN_THRESHOLD) {
      try {
        await saveTextContextResource({
          conversationId: topicId,
          sourceMessageId: assistantMessage.id,
          sourceName: `agent-result-${assistantMessage.id}`,
          text: completedContent,
          kind: 'tool-result',
          metadata: {
            agentId: agentSession.agentId,
            sessionId: agentSession.sessionId,
            largeResult: true
          }
        })
        const resources = await listContextResources(topicId)
        recordContextResourceCount(topicId, resources.length)
      } catch (error) {
        logger.warn('Failed to persist a large Agent result as a local context resource', error as Error)
      }
    }

    if (latestAgentSessionId) {
      await persistAgentSessionId(latestAgentSessionId)
    }

    if (shouldShowWechatSync && !agentSessionSyncResolved) {
      await updateAgentSessionSyncStatus(dispatch, getState, topicId, syncMessageIds, 'failed', 'sync_result_missing')
    }
    completedSuccessfully = true
    setContextProcessingStatus(topicId, 'complete', '上下文已就绪')
  } catch (error: any) {
    logger.error('Error in fetchAndProcessAgentResponseImpl:', error)
    if (isAbortError(error)) {
      setContextProcessingStatus(topicId, 'complete', '任务已停止')
    } else {
      markContextProcessingError(topicId, error)
    }
    try {
      await callbacks.onError?.(error)
    } catch (callbackError) {
      logger.error('Error in agent onError callback:', callbackError as Error)
    }
    if (shouldShowWechatSync) {
      await updateAgentSessionSyncStatus(
        dispatch,
        getState,
        topicId,
        syncMessageIds,
        'failed',
        error instanceof Error ? error.message : String(error)
      )
    }
  } finally {
    if (
      !completedSuccessfully &&
      getState().messages.entities[assistantMessage.id]?.status === AssistantMessageStatus.SUCCESS
    ) {
      setContextProcessingStatus(topicId, 'complete', '上下文已就绪')
    }
    dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    void renameAgentSessionIfNeeded(agentSession, topicId, getState)
  }
}

// Removed persistAgentExchange and createPersistedMessagePayload functions
// These are no longer needed since messages are saved immediately via appendMessage
// and updated during streaming via updateMessageAndBlocks

// --- Helper Function for Multi-Model Dispatch ---
// 多模型创建和发送请求的逻辑，用于用户消息多模型发送和重发
const dispatchMultiModelResponses = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  triggeringMessage: Message, // userMessage or messageToResend
  assistant: Assistant,
  mentionedModels: Model[]
) => {
  const assistantMessageStubs: Message[] = []
  const tasksToQueue: { assistantConfig: Assistant; messageStub: Message }[] = []

  for (const mentionedModel of mentionedModels) {
    const assistantForThisMention = { ...assistant, model: mentionedModel }
    const assistantMessage = createAssistantMessage(assistant.id, topicId, {
      askId: triggeringMessage.id,
      model: mentionedModel,
      modelId: mentionedModel.id,
      traceId: triggeringMessage.traceId
    })
    dispatch(newMessagesActions.addMessage({ topicId, message: assistantMessage }))
    assistantMessageStubs.push(assistantMessage)
    tasksToQueue.push({
      assistantConfig: assistantForThisMention,
      messageStub: assistantMessage
    })
  }

  const topicFromDB = await db.topics.get(topicId)
  if (topicFromDB) {
    const currentTopicMessageIds = getState().messages.messageIdsByTopic[topicId] || []
    const currentEntities = getState().messages.entities
    const messagesToSaveInDB = currentTopicMessageIds.map((id) => currentEntities[id]).filter((m): m is Message => !!m)
    await db.topics.update(topicId, { messages: messagesToSaveInDB })
  } else {
    logger.error(`[dispatchMultiModelResponses] Topic ${topicId} not found in DB during multi-model save.`)
    throw new Error(`Topic ${topicId} not found in DB.`)
  }

  const queue = getTopicQueue(topicId)
  for (const task of tasksToQueue) {
    void queue.add(async () => {
      await fetchAndProcessAssistantResponseImpl(dispatch, getState, topicId, task.assistantConfig, task.messageStub)
    })
  }
}

// --- End Helper Function ---
// 发送和处理助手响应的实现函数，话题提示词在此拼接
const fetchAndProcessAssistantResponseImpl = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  origAssistant: Assistant,
  assistantMessage: Message // Pass the prepared assistant message (new or reset)
) => {
  const topic = origAssistant.topics.find((t) => t.id === topicId)
  const assistant = topic?.prompt
    ? { ...origAssistant, prompt: `${origAssistant.prompt}\n${topic.prompt}` }
    : origAssistant
  const assistantMsgId = assistantMessage.id
  let callbacks: StreamProcessorCallbacks = {}
  try {
    dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))

    // 创建 BlockManager 实例
    const blockManager = new BlockManager({
      dispatch,
      getState,
      saveUpdatedBlockToDB,
      saveUpdatesToDB,
      assistantMsgId,
      topicId,
      throttledBlockUpdate,
      cancelThrottledBlockUpdate
    })

    const allMessagesForTopic = selectMessagesForTopic(getState(), topicId)

    let messagesForContext: Message[] = []
    const userMessageId = assistantMessage.askId
    const userMessageIndex = allMessagesForTopic.findIndex((m) => m?.id === userMessageId)

    if (userMessageIndex === -1) {
      logger.error(
        `[fetchAndProcessAssistantResponseImpl] Triggering user message ${userMessageId} (askId of ${assistantMsgId}) not found. Falling back.`
      )
      const assistantMessageIndexFallback = allMessagesForTopic.findIndex((m) => m?.id === assistantMsgId)
      messagesForContext = (
        assistantMessageIndexFallback !== -1
          ? allMessagesForTopic.slice(0, assistantMessageIndexFallback)
          : allMessagesForTopic
      ).filter((m) => m && !m.status?.includes('ing'))
    } else {
      const contextSlice = allMessagesForTopic.slice(0, userMessageIndex + 1)
      messagesForContext = contextSlice.filter((m) => m && !m.status?.includes('ing'))
    }

    // Ensure at least the triggering user message is present to avoid empty payloads
    if ((!messagesForContext || messagesForContext.length === 0) && userMessageId) {
      const stateAfter = getState()
      const maybeUserMessage = stateAfter.messages.entities[userMessageId]
      if (maybeUserMessage) {
        messagesForContext = [maybeUserMessage]
      }
    }

    callbacks = createCallbacks({
      blockManager,
      dispatch,
      getState,
      topicId,
      assistantMsgId,
      saveUpdatesToDB,
      assistant
    })
    const streamProcessorCallbacks = createStreamProcessor(callbacks)

    const abortController = new AbortController()
    logger.silly('Add Abort Controller', { id: userMessageId })
    addAbortController(userMessageId!, () => abortController.abort())

    // Fetch agent allowed_tools for MCP auto-approval
    let allowedTools: string[] | undefined
    const activeAgentId = getState().runtime.chat.activeAgentId
    const apiServer = getState().settings.apiServer
    if (activeAgentId && apiServer?.apiKey) {
      try {
        const baseURL = buildAgentBaseURL(apiServer)
        const agentClient = new AgentApiClient({
          baseURL,
          headers: {
            Authorization: `Bearer ${apiServer.apiKey}`
          }
        })
        const agentData = await agentClient.getAgent(activeAgentId)
        allowedTools = agentData?.allowed_tools
      } catch {
        // Agent fetch failed — proceed without allowedTools
      }
    }

    await transformMessagesAndFetch(
      {
        messages: messagesForContext,
        assistant,
        topicId,
        allowedTools,
        blockManager,
        assistantMsgId,
        callbacks,
        options: {
          signal: abortController.signal,
          headers: defaultAppHeaders()
        }
      },
      streamProcessorCallbacks
    )
    await finalizeStaleAssistantBlocksAfterStream(dispatch, getState, topicId, assistantMsgId)
  } catch (error: any) {
    logger.error('Error in fetchAndProcessAssistantResponseImpl:', error)
    endSpan({
      topicId,
      error: error,
      modelName: assistant.model?.name
    })
    // 统一错误处理：确保 loading 状态被正确设置，避免队列任务卡住
    try {
      await callbacks.onError?.(error)
    } catch (callbackError) {
      logger.error('Error in onError callback:', callbackError as Error)
    } finally {
      // 确保无论如何都设置 loading 为 false（onError 回调中已设置，这里是保险）
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    }
  }
}

/**
 * 发送消息并处理助手回复
 * @param userMessage 已创建的用户消息
 * @param userMessageBlocks 用户消息关联的消息块
 * @param assistant 助手对象
 * @param topicId 主题ID
 */
export const sendMessage =
  (
    userMessage: Message,
    userMessageBlocks: MessageBlock[],
    assistant: Assistant,
    topicId: Topic['id'],
    agentSession?: AgentSessionContext
  ) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      if (userMessage.blocks.length === 0) {
        logger.warn('sendMessage: No blocks in the provided message.')
        return
      }

      const stateBeforeSend = getState()
      let activeAgentSession = agentSession ?? findExistingAgentSessionContext(stateBeforeSend, topicId, assistant.id)
      if (activeAgentSession) {
        const derivedSession = findExistingAgentSessionContext(stateBeforeSend, topicId, assistant.id)
        if (derivedSession?.agentSessionId && derivedSession.agentSessionId !== activeAgentSession.agentSessionId) {
          activeAgentSession = {
            ...activeAgentSession,
            agentSessionId: derivedSession.agentSessionId
          }
        }
      }
      if (activeAgentSession?.agentSessionId && !userMessage.agentSessionId) {
        userMessage.agentSessionId = activeAgentSession.agentSessionId
      }

      let shouldShowWechatSync = false
      if (activeAgentSession) {
        shouldShowWechatSync = await isWechatBoundAgentSession(stateBeforeSend.settings.apiServer, activeAgentSession)
        if (shouldShowWechatSync) {
          userMessage.providerMetadata = withAgentSessionSyncMetadata(userMessage, 'pending')
        }
      }

      await saveMessageAndBlocksToDB(topicId, userMessage, userMessageBlocks)
      dispatch(newMessagesActions.addMessage({ topicId, message: userMessage }))
      if (userMessageBlocks.length > 0) {
        dispatch(upsertManyBlocks(userMessageBlocks))
      }
      dispatch(updateTopicUpdatedAt({ topicId }))

      const queue = getTopicQueue(topicId)

      if (activeAgentSession) {
        const assistantMessage = createAssistantMessage(assistant.id, topicId, {
          askId: userMessage.id,
          model: assistant.model,
          traceId: userMessage.traceId,
          ...(shouldShowWechatSync
            ? {
                providerMetadata: {
                  agentSessionSync: buildAgentSessionSyncMetadata('pending')
                } as MessageProviderMetadata
              }
            : {})
        })
        if (activeAgentSession.agentSessionId && !assistantMessage.agentSessionId) {
          assistantMessage.agentSessionId = activeAgentSession.agentSessionId
        }
        await saveMessageAndBlocksToDB(topicId, assistantMessage, [])
        dispatch(newMessagesActions.addMessage({ topicId, message: assistantMessage }))

        void queue.add(async () => {
          await fetchAndProcessAgentResponseImpl(dispatch, getState, {
            topicId,
            assistant,
            assistantMessage,
            agentSession: activeAgentSession,
            userMessageId: userMessage.id
          })
        })
      } else {
        const mentionedModels = userMessage.mentions

        if (mentionedModels && mentionedModels.length > 0) {
          await dispatchMultiModelResponses(dispatch, getState, topicId, userMessage, assistant, mentionedModels)
        } else {
          const assistantMessage = createAssistantMessage(assistant.id, topicId, {
            askId: userMessage.id,
            model: assistant.model,
            traceId: userMessage.traceId
          })
          await saveMessageAndBlocksToDB(topicId, assistantMessage, [])
          dispatch(
            newMessagesActions.addMessage({
              topicId,
              message: assistantMessage
            })
          )

          void queue.add(async () => {
            await fetchAndProcessAssistantResponseImpl(dispatch, getState, topicId, assistant, assistantMessage)
          })
        }
      }
    } catch (error) {
      logger.error('Error in sendMessage thunk:', error as Error)
    } finally {
      void finishTopicLoading(topicId)
    }
  }

/**
 * Loads agent session messages from backend
 */
export const loadAgentSessionMessagesThunk =
  // oxlint-disable-next-line no-unused-vars
  (sessionId: string) => async (dispatch: AppDispatch, _getState: () => RootState) => {
    const topicId = buildAgentSessionTopicId(sessionId)

    try {
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))

      // Fetch from agent backend
      const historicalMessages = await window.electron?.ipcRenderer.invoke(IpcChannel.AgentMessage_GetHistory, {
        sessionId
      })

      if (historicalMessages && Array.isArray(historicalMessages)) {
        const messages: Message[] = []
        const blocks: MessageBlock[] = []

        for (const persistedMsg of historicalMessages) {
          if (persistedMsg?.message) {
            messages.push(persistedMsg.message)
            if (persistedMsg.blocks && persistedMsg.blocks.length > 0) {
              blocks.push(...persistedMsg.blocks)
            }
          }
        }

        // Update Redux store
        if (blocks.length > 0) {
          dispatch(upsertManyBlocks(blocks))
        }
        dispatch(newMessagesActions.messagesReceived({ topicId, messages }))

        logger.silly(`Loaded ${messages.length} messages for agent session ${sessionId}`)
      } else {
        dispatch(newMessagesActions.messagesReceived({ topicId, messages: [] }))
      }
    } catch (error) {
      logger.error(`Failed to load agent session messages for ${sessionId}:`, error as Error)
      dispatch(newMessagesActions.messagesReceived({ topicId, messages: [] }))
    } finally {
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    }
  }

/**
 * Loads messages and their blocks for a specific topic from the database
 * and updates the Redux store.
 */
// export const loadTopicMessagesThunk =
//   (topicId: string, forceReload: boolean = false) =>
//   async (dispatch: AppDispatch, getState: () => RootState) => {
//     return loadTopicMessagesThunkV2(topicId, forceReload)(dispatch, getState)
//   }

/**
 * Thunk to delete a single message and its associated blocks.
 */
export const deleteSingleMessageThunk =
  (topicId: string, messageId: string) => async (dispatch: AppDispatch, getState: () => RootState) => {
    const currentState = getState()
    const messageToDelete = currentState.messages.entities[messageId]
    if (!messageToDelete || messageToDelete.topicId !== topicId) {
      logger.error(`[deleteSingleMessage] Message ${messageId} not found in topic ${topicId}.`)
      return
    }

    const blockIdsToDelete = messageToDelete.blocks || []

    try {
      dispatch(newMessagesActions.removeMessage({ topicId, messageId }))
      cleanupMultipleBlocks(dispatch, blockIdsToDelete)
      await deleteMessageFromDB(topicId, messageId)
      clearContextCheckpoint(topicId)
      clearContextTelemetry(topicId)
      await deleteContextResourcesForMessages(topicId, [messageId])
    } catch (error) {
      logger.error(`[deleteSingleMessage] Failed to delete message ${messageId}:`, error as Error)
    }
  }

/**
 * Thunk to delete a group of messages (user query + assistant responses) based on askId.
 */
export const deleteMessageGroupThunk =
  (topicId: string, askId: string) => async (dispatch: AppDispatch, getState: () => RootState) => {
    const currentState = getState()
    const topicMessageIds = currentState.messages.messageIdsByTopic[topicId] || []
    const messagesToDelete: Message[] = []

    topicMessageIds.forEach((id) => {
      const msg = currentState.messages.entities[id]
      if (msg && msg.askId === askId) {
        messagesToDelete.push(msg)
      }
    })

    // const userQuery = currentState.messages.entities[askId]
    // if (userQuery && userQuery.topicId === topicId && !idsToDelete.includes(askId)) {
    //   messagesToDelete.push(userQuery)
    //   idsToDelete.push(askId)
    // }

    if (messagesToDelete.length === 0) {
      logger.warn(`[deleteMessageGroup] No messages found with askId ${askId} in topic ${topicId}.`)
      return
    }

    const blockIdsToDelete = messagesToDelete.flatMap((m) => m.blocks || [])
    const messageIdsToDelete = messagesToDelete.map((m) => m.id)

    try {
      dispatch(newMessagesActions.removeMessagesByAskId({ topicId, askId }))
      cleanupMultipleBlocks(dispatch, blockIdsToDelete)
      await deleteMessagesFromDB(topicId, messageIdsToDelete)
      clearContextCheckpoint(topicId)
      clearContextTelemetry(topicId)
      await deleteContextResourcesForMessages(topicId, messageIdsToDelete)
    } catch (error) {
      logger.error(`[deleteMessageGroup] Failed to delete messages with askId ${askId}:`, error as Error)
    }
  }

/**
 * Thunk to clear all messages and associated blocks for a topic.
 */
export const clearTopicMessagesThunk =
  (topicId: string) => async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      const state = getState()
      const messageIdsToClear = state.messages.messageIdsByTopic[topicId] || []
      const blockIdsToDeleteSet = new Set<string>()

      messageIdsToClear.forEach((messageId) => {
        const message = state.messages.entities[messageId]
        message?.blocks?.forEach((blockId) => blockIdsToDeleteSet.add(blockId))
      })

      const blockIdsToDelete = Array.from(blockIdsToDeleteSet)

      dispatch(newMessagesActions.clearTopicMessages(topicId))
      cleanupMultipleBlocks(dispatch, blockIdsToDelete)
      await clearMessagesFromDB(topicId)
      clearContextCheckpoint(topicId)
      await deleteContextResources(topicId)
      clearContextTelemetry(topicId)
    } catch (error) {
      logger.error(`[clearTopicMessagesThunk] Failed to clear messages for topic ${topicId}:`, error as Error)
    }
  }

/**
 * Thunk to resend a user message by regenerating its associated assistant responses.
 * Finds all assistant messages responding to the given user message, resets them,
 * and queues them for regeneration without deleting other messages.
 */
export const resendMessageThunk =
  (topicId: Topic['id'], userMessageToResend: Message, assistant: Assistant) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      if (isAgentSessionTopicId(topicId)) {
        await runAgentSessionResend(dispatch, getState, topicId, userMessageToResend, assistant)
        return
      }

      const state = getState()
      const conversationModel = getCurrentTopicModel(state, topicId, assistant)
      // Use selector to get all messages for the topic
      const allMessagesForTopic = selectMessagesForTopic(state, topicId)

      // Filter to find the assistant messages to reset
      const assistantMessagesToReset = allMessagesForTopic.filter(
        (m) => m.askId === userMessageToResend.id && m.role === 'assistant'
      )

      // Clear cached search results for the user message being resent
      // This ensures that the regenerated responses will not use stale search results
      try {
        window.keyv.remove(`web-search-${userMessageToResend.id}`)
        window.keyv.remove(`knowledge-search-${userMessageToResend.id}`)
      } catch (error) {
        logger.warn(`Failed to clear keyv cache for message ${userMessageToResend.id}:`, error as Error)
      }

      const resetDataList: Message[] = []

      if (assistantMessagesToReset.length === 0 && !userMessageToResend?.mentions?.length) {
        // 没有相关的助手消息且没有提及模型时，使用助手模型创建一条消息

        const assistantMessage = createAssistantMessage(assistant.id, topicId, {
          askId: userMessageToResend.id,
          model: conversationModel
        })
        assistantMessage.traceId = userMessageToResend.traceId
        resetDataList.push(assistantMessage)

        resetDataList.forEach((message) => {
          dispatch(newMessagesActions.addMessage({ topicId, message }))
        })
      }

      // 处理存在相关的助手消息的情况
      const allBlockIdsToDelete: string[] = []
      const messagesToUpdateInRedux: {
        topicId: string
        messageId: string
        updates: Partial<Message>
      }[] = []

      // 先处理已有的重传
      for (const originalMsg of assistantMessagesToReset) {
        const retryModel = resolveRetryModelSelection({
          conversationModel,
          originalAssistantMessage: originalMsg,
          preserveOriginalModel: assistantMessagesToReset.length > 1 || Boolean(userMessageToResend.mentions?.length)
        })
        const blockIdsToDelete = [...(originalMsg.blocks || [])]
        const resetMsg = resetAssistantMessage(originalMsg, {
          status: AssistantMessageStatus.PENDING,
          updatedAt: new Date().toISOString(),
          ...retryModel
        })

        resetDataList.push(resetMsg)
        allBlockIdsToDelete.push(...blockIdsToDelete)
        messagesToUpdateInRedux.push({
          topicId,
          messageId: resetMsg.id,
          updates: resetMsg
        })
      }

      // 再处理新的重传（用户消息提及，但是现有助手消息中不存在提及的模型）
      const originModelSet = new Set(assistantMessagesToReset.map((m) => m.model).filter((m) => m !== undefined))
      const mentionedModelSet = new Set(userMessageToResend.mentions ?? [])
      const newModelSet = new Set([...mentionedModelSet].filter((m) => !originModelSet.has(m)))
      for (const model of newModelSet) {
        const assistantMessage = createAssistantMessage(assistant.id, topicId, {
          askId: userMessageToResend.id,
          model: model,
          modelId: model.id
        })
        resetDataList.push(assistantMessage)
        dispatch(newMessagesActions.addMessage({ topicId, message: assistantMessage }))
      }

      messagesToUpdateInRedux.forEach((update) => dispatch(newMessagesActions.updateMessage(update)))
      cleanupMultipleBlocks(dispatch, allBlockIdsToDelete)

      try {
        if (allBlockIdsToDelete.length > 0) {
          await db.message_blocks.bulkDelete(allBlockIdsToDelete)
        }
        const finalMessagesToSave = selectMessagesForTopic(getState(), topicId)
        await db.topics.update(topicId, { messages: finalMessagesToSave })
      } catch (dbError) {
        logger.error('[resendMessageThunk] Error updating database:', dbError as Error)
      }

      const queue = getTopicQueue(topicId)
      for (const resetMsg of resetDataList) {
        const assistantConfigForThisRegen = {
          ...assistant,
          ...(resetMsg.model ? { model: resetMsg.model } : {})
        }
        void queue.add(async () => {
          await fetchAndProcessAssistantResponseImpl(dispatch, getState, topicId, assistantConfigForThisRegen, resetMsg)
        })
      }
    } catch (error) {
      logger.error(`[resendMessageThunk] Error resending user message ${userMessageToResend.id}:`, error as Error)
    } finally {
      void finishTopicLoading(topicId)
    }
  }

/**
 * Thunk to resend a user message after its content has been edited.
 * Updates the user message's text block and then triggers the regeneration
 * of its associated assistant responses using resendMessageThunk.
 */
export const resendUserMessageWithEditThunk =
  (topicId: Topic['id'], originalMessage: Message, assistant: Assistant) => async (dispatch: AppDispatch) => {
    // Trigger the regeneration logic for associated assistant messages
    void dispatch(resendMessageThunk(topicId, originalMessage, assistant))
  }

/**
 * Thunk to regenerate a specific assistant response.
 */
export const regenerateAssistantResponseThunk =
  (topicId: Topic['id'], assistantMessageToRegenerate: Message, assistant: Assistant) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      if (isAgentSessionTopicId(topicId)) {
        const state = getState()
        const askId = assistantMessageToRegenerate.askId

        if (!askId) {
          logger.error(
            `[regenerateAssistantResponseThunk] Assistant message ${assistantMessageToRegenerate.id} does not have an askId.`
          )
          return
        }

        const originalUserQuery = state.messages.entities[askId]
        if (!originalUserQuery) {
          logger.error(
            `[regenerateAssistantResponseThunk] Original user query ${askId} not found for session regeneration.`
          )
          window.toast.error(t('error.missing_user_message'))
          return
        }

        await runAgentSessionResend(dispatch, getState, topicId, originalUserQuery, assistant)
        return
      }

      const state = getState()
      const conversationModel = getCurrentTopicModel(state, topicId, assistant)

      // 1. Use selector to get all messages for the topic
      const allMessagesForTopic = selectMessagesForTopic(state, topicId)

      const askId = assistantMessageToRegenerate.askId

      if (!askId) {
        logger.error(
          `[appendAssistantResponseThunk] Existing assistant message ${assistantMessageToRegenerate.id} does not have an askId.`
        )
        return // Stop if askId is missing
      }

      if (!state.messages.entities[askId]) {
        logger.error(
          `[appendAssistantResponseThunk] Original user query (askId: ${askId}) not found in entities. Cannot create assistant response without corresponding user message.`
        )

        // Show error popup instead of creating error message block
        window.toast.error(t('error.missing_user_message'))

        return
      }

      // 2. Find the original user query (Restored Logic)
      const originalUserQuery = allMessagesForTopic.find((m) => m.id === assistantMessageToRegenerate.askId)
      if (!originalUserQuery) {
        logger.error(
          `[regenerateAssistantResponseThunk] Original user query (askId: ${assistantMessageToRegenerate.askId}) not found for assistant message ${assistantMessageToRegenerate.id}. Cannot regenerate.`
        )
        return
      }

      // 3. Verify the assistant message itself exists in entities
      const messageToResetEntity = state.messages.entities[assistantMessageToRegenerate.id]
      if (!messageToResetEntity) {
        // No need to check topicId again as selector implicitly handles it
        logger.error(
          `[regenerateAssistantResponseThunk] Assistant message ${assistantMessageToRegenerate.id} not found in entities despite being in the topic list. State might be inconsistent.`
        )
        return
      }

      // 4. Get Block IDs to delete
      const blockIdsToDelete = [...(messageToResetEntity.blocks || [])]

      // 5. Reset the message entity in Redux
      const hasSiblingAssistantResponses = allMessagesForTopic.some(
        (message) =>
          message.role === 'assistant' &&
          message.askId === originalUserQuery.id &&
          message.id !== messageToResetEntity.id
      )
      const retryModel = resolveRetryModelSelection({
        conversationModel,
        originalAssistantMessage: messageToResetEntity,
        preserveOriginalModel: Boolean(originalUserQuery.mentions?.length) || hasSiblingAssistantResponses
      })
      const resetAssistantMsg = resetAssistantMessage(messageToResetEntity, {
        status: AssistantMessageStatus.PENDING,
        updatedAt: new Date().toISOString(),
        ...retryModel
      })

      dispatch(
        newMessagesActions.updateMessage({
          topicId,
          messageId: resetAssistantMsg.id,
          updates: resetAssistantMsg
        })
      )

      // 6. Remove old blocks from Redux
      cleanupMultipleBlocks(dispatch, blockIdsToDelete)

      // 7. Update DB: Save the reset message state within the topic and delete old blocks
      // Fetch the current state *after* Redux updates to get the latest message list
      // Use the selector to get the final ordered list of messages for the topic
      const finalMessagesToSave = selectMessagesForTopic(getState(), topicId)

      await db.transaction('rw', db.topics, db.message_blocks, async () => {
        // Use the result from the selector to update the DB
        await db.topics.update(topicId, { messages: finalMessagesToSave })
        if (blockIdsToDelete.length > 0) {
          await db.message_blocks.bulkDelete(blockIdsToDelete)
        }
      })

      // 8. Add fetch/process call to the queue
      const queue = getTopicQueue(topicId)
      const assistantConfigForRegen = {
        ...assistant,
        ...(resetAssistantMsg.model ? { model: resetAssistantMsg.model } : {})
      }
      void queue.add(async () => {
        await fetchAndProcessAssistantResponseImpl(
          dispatch,
          getState,
          topicId,
          assistantConfigForRegen,
          resetAssistantMsg
        )
      })
    } catch (error) {
      logger.error(
        `[regenerateAssistantResponseThunk] Error regenerating response for assistant message ${assistantMessageToRegenerate.id}:`,
        error as Error
      )
      // dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    } finally {
      void finishTopicLoading(topicId)
    }
  }

// --- Thunk to initiate translation and create the initial block ---
export const initiateTranslationThunk =
  (
    messageId: string,
    topicId: string,
    targetLanguage: string,
    sourceBlockId?: string, // Optional: If known
    sourceLanguage?: string // Optional: If known
  ) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<string | undefined> => {
    // Return the new block ID
    try {
      const state = getState()
      const originalMessage = state.messages.entities[messageId]

      if (!originalMessage) {
        logger.error(`[initiateTranslationThunk] Original message ${messageId} not found.`)
        return undefined
      }

      // 1. Create the initial translation block (streaming state)
      const newBlock = createTranslationBlock(
        messageId,
        '', // Start with empty content
        targetLanguage,
        {
          status: MessageBlockStatus.STREAMING, // Set to STREAMING
          sourceBlockId,
          sourceLanguage
        }
      )

      // 2. Update Redux State
      const updatedBlockIds = [...(originalMessage.blocks || []), newBlock.id]
      dispatch(upsertOneBlock(newBlock)) // Add the new block
      dispatch(
        newMessagesActions.updateMessage({
          topicId,
          messageId,
          updates: { blocks: updatedBlockIds } // Update message's block list
        })
      )

      // 3. Update Database
      // Get the final message list from Redux state *after* updates
      const finalMessagesToSave = selectMessagesForTopic(getState(), topicId)

      await db.transaction('rw', db.topics, db.message_blocks, async () => {
        await db.message_blocks.put(newBlock) // Save the initial block
        await db.topics.update(topicId, { messages: finalMessagesToSave }) // Save updated message list
      })
      return newBlock.id // Return the ID
    } catch (error) {
      logger.error(`[initiateTranslationThunk] Failed for message ${messageId}:`, error as Error)
      return undefined
      // Optional: Dispatch an error action or show notification
    }
  }

// --- Thunk to update the translation block with new content ---
export const updateTranslationBlockThunk =
  (blockId: string, accumulatedText: string, isComplete: boolean = false) =>
  async (dispatch: AppDispatch) => {
    // Logger.log(`[updateTranslationBlockThunk] 更新翻译块 ${blockId}, isComplete: ${isComplete}`)
    try {
      const status = isComplete ? MessageBlockStatus.SUCCESS : MessageBlockStatus.STREAMING
      const changes: Partial<MessageBlock> = {
        content: accumulatedText,
        status: status
      }

      // 更新Redux状态
      dispatch(updateOneBlock({ id: blockId, changes }))

      await updateSingleBlock(blockId, changes)
      // Logger.log(`[updateTranslationBlockThunk] Successfully updated translation block ${blockId}.`)
    } catch (error) {
      logger.error(`[updateTranslationBlockThunk] Failed to update translation block ${blockId}:`, error as Error)
    }
  }

/**
 * Thunk to append a new assistant response (using a potentially different model)
 * in reply to the same user query as an existing assistant message.
 */
export const appendAssistantResponseThunk =
  (
    topicId: Topic['id'],
    existingAssistantMessageId: string, // ID of the assistant message the user interacted with
    newModel: Model, // The new model selected by the user
    assistant: Assistant, // Base assistant configuration
    traceId?: string
  ) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      const state = getState()

      // 1. Find the existing assistant message to get the original askId
      const existingAssistantMsg = state.messages.entities[existingAssistantMessageId]
      if (!existingAssistantMsg) {
        logger.error(
          `[appendAssistantResponseThunk] Existing assistant message ${existingAssistantMessageId} not found.`
        )
        return // Stop if the reference message doesn't exist
      }
      if (existingAssistantMsg.role !== 'assistant') {
        logger.error(
          `[appendAssistantResponseThunk] Message ${existingAssistantMessageId} is not an assistant message.`
        )
        return // Ensure it's an assistant message
      }
      const askId = existingAssistantMsg.askId
      if (!askId) {
        logger.error(
          `[appendAssistantResponseThunk] Existing assistant message ${existingAssistantMessageId} does not have an askId.`
        )
        return // Stop if askId is missing
      }

      // (Optional but recommended) Verify the original user query exists
      if (!state.messages.entities[askId]) {
        logger.error(
          `[appendAssistantResponseThunk] Original user query (askId: ${askId}) not found in entities. Cannot create assistant response without corresponding user message.`
        )

        // Show error popup instead of creating error message block
        window.toast.error(t('error.missing_user_message'))

        return
      }

      // 2. Create the new assistant message stub
      const newAssistantMessageStub = createAssistantMessage(assistant.id, topicId, {
        askId: askId, // Crucial: Use the original askId
        model: newModel,
        modelId: newModel.id,
        traceId: traceId
      })

      // 3. Update Redux Store
      const currentTopicMessageIds = getState().messages.messageIdsByTopic[topicId] || []
      const existingMessageIndex = currentTopicMessageIds.findIndex((id) => id === existingAssistantMessageId)
      const insertAtIndex = existingMessageIndex !== -1 ? existingMessageIndex + 1 : currentTopicMessageIds.length

      // 4. Update Database (Save the stub to the topic's message list)
      await saveMessageAndBlocksToDB(topicId, newAssistantMessageStub, [], insertAtIndex)

      dispatch(
        newMessagesActions.insertMessageAtIndex({
          topicId,
          message: newAssistantMessageStub,
          index: insertAtIndex
        })
      )

      void dispatch(updateMessageAndBlocksThunk(topicId, { id: existingAssistantMessageId, foldSelected: false }, []))
      void dispatch(updateMessageAndBlocksThunk(topicId, { id: newAssistantMessageStub.id, foldSelected: true }, []))

      // 5. Prepare and queue the processing task
      const assistantConfigForThisCall = {
        ...assistant,
        model: newModel
      }
      const queue = getTopicQueue(topicId)
      void queue.add(async () => {
        await fetchAndProcessAssistantResponseImpl(
          dispatch,
          getState,
          topicId,
          assistantConfigForThisCall,
          newAssistantMessageStub // Pass the newly created stub
        )
      })
    } catch (error) {
      logger.error(`[appendAssistantResponseThunk] Error appending assistant response:`, error as Error)
      // Optionally dispatch an error action or notification
      // Resetting loading state should be handled by the underlying fetchAndProcessAssistantResponseImpl
    } finally {
      void finishTopicLoading(topicId)
    }
  }

/**
 * Clones messages from a source topic up to a specified index into a *pre-existing* new topic.
 * Generates new unique IDs for all cloned messages and blocks.
 * Updates the DB and Redux message/block state for the new topic.
 * Assumes the newTopic object already exists in Redux topic state and DB.
 * @param sourceTopicId The ID of the topic to branch from.
 * @param branchPointIndex The index *after* which messages should NOT be copied (slice endpoint).
 * @param newTopic The newly created Topic object (created and added to Redux/DB by the caller).
 */
export const cloneMessagesToNewTopicThunk =
  (
    sourceTopicId: string,
    branchPointIndex: number,
    newTopic: Topic // Receive newTopic object
  ) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<boolean> => {
    if (!newTopic || !newTopic.id) {
      logger.error(`[cloneMessagesToNewTopicThunk] Invalid newTopic provided.`)
      return false
    }
    try {
      const state = getState()
      const sourceMessages = selectMessagesForTopic(state, sourceTopicId)

      if (!sourceMessages || sourceMessages.length === 0) {
        logger.error(`[cloneMessagesToNewTopicThunk] Source topic ${sourceTopicId} not found or is empty.`)
        return false
      }

      // 1. Slice messages to clone
      const messagesToClone = sourceMessages.slice(0, branchPointIndex)
      if (messagesToClone.length === 0) {
        logger.warn(`[cloneMessagesToNewTopicThunk] No messages to branch (index ${branchPointIndex}).`)
        return true // Nothing to clone, operation considered successful but did nothing.
      }

      // 2. Prepare for cloning: Maps and Arrays
      const clonedMessages: Message[] = []
      const clonedBlocks: MessageBlock[] = []
      const filesToUpdateCount: FileMetadata[] = []
      const originalToNewMsgIdMap = new Map<string, string>() // Map original message ID -> new message ID

      // 3. First pass: Create ID mappings for all messages
      for (const oldMessage of messagesToClone) {
        const newMsgId = uuid()
        originalToNewMsgIdMap.set(oldMessage.id, newMsgId) // Store mapping for all cloned messages
      }

      // 4. Second pass: Clone Messages and Blocks with New IDs using complete mapping
      for (const oldMessage of messagesToClone) {
        const newMsgId = originalToNewMsgIdMap.get(oldMessage.id)!

        let newAskId: string | undefined = undefined // Initialize newAskId
        if (oldMessage.role === 'assistant' && oldMessage.askId) {
          // If it's an assistant message with an askId, find the NEW ID of the user message it references
          const mappedNewAskId = originalToNewMsgIdMap.get(oldMessage.askId)
          if (mappedNewAskId) {
            newAskId = mappedNewAskId // Use the new ID
          } else {
            // This happens if the user message corresponding to askId was *before* the branch point index
            // and thus wasn't included in messagesToClone or the map.
            // In this case, the link is broken in the new topic.
            logger.warn(
              `[cloneMessages] Could not find new ID mapping for original askId ${oldMessage.askId} (likely outside branch). Setting askId to undefined for new assistant message ${newMsgId}.`
            )
            // newAskId remains undefined
          }
        }

        // --- Clone Blocks ---
        const newBlockIds: string[] = []
        if (oldMessage.blocks && oldMessage.blocks.length > 0) {
          for (const oldBlockId of oldMessage.blocks) {
            const oldBlock = state.messageBlocks.entities[oldBlockId]
            if (oldBlock) {
              const newBlockId = uuid()
              const newBlock = {
                ...oldBlock,
                id: newBlockId,
                messageId: newMsgId // Link block to the NEW message ID
              }
              clonedBlocks.push(newBlock)
              newBlockIds.push(newBlockId)

              if (newBlock.type === MessageBlockType.FILE || newBlock.type === MessageBlockType.IMAGE) {
                const fileInfo = (newBlock as FileMessageBlock | ImageMessageBlock).file
                if (fileInfo) {
                  filesToUpdateCount.push(fileInfo)
                }
              }
            } else {
              logger.warn(
                `[cloneMessagesToNewTopicThunk] Block ${oldBlockId} not found in state for message ${oldMessage.id}. Skipping block clone.`
              )
            }
          }
        }

        // --- Create New Message Object ---
        const newMessage: Message = {
          ...oldMessage,
          id: newMsgId,
          topicId: newTopic.id, // Use the NEW topic ID provided
          blocks: newBlockIds // Use the NEW block IDs
        }
        if (newMessage.role === 'assistant') {
          newMessage.askId = newAskId // Use the mapped/updated askId
        }
        clonedMessages.push(newMessage)
      }

      // 5. Update Database (Atomic Transaction)
      await db.transaction('rw', db.topics, db.message_blocks, db.files, async () => {
        // Update the NEW topic with the cloned messages
        // Assumes topic entry was added by caller, so we UPDATE.
        await db.topics.put({ ...newTopic, messages: clonedMessages })

        // Add the NEW blocks
        if (clonedBlocks.length > 0) {
          await bulkAddBlocks(clonedBlocks)
        }
        // Update file counts
        const uniqueFiles = [...new Map(filesToUpdateCount.map((f) => [f.id, f])).values()]
        for (const file of uniqueFiles) {
          await updateFileCount(file.id, 1, false)
        }
      })

      // --- Update Redux State ---
      dispatch(
        newMessagesActions.messagesReceived({
          topicId: newTopic.id,
          messages: clonedMessages
        })
      )
      if (clonedBlocks.length > 0) {
        dispatch(upsertManyBlocks(clonedBlocks))
      }

      return true // Indicate success
    } catch (error) {
      logger.error(`[cloneMessagesToNewTopicThunk] Failed to clone messages:`, error as Error)
      return false // Indicate failure
    }
  }

/**
 * Thunk to edit properties of a message and/or its associated blocks.
 * Updates Redux state and persists changes to the database within a transaction.
 * Message updates are optional if only blocks need updating.
 */
export const updateMessageAndBlocksThunk =
  (
    topicId: string,
    // Allow messageUpdates to be optional or just contain the ID if only blocks are updated
    messageUpdates: (Partial<Message> & Pick<Message, 'id'>) | null, // ID is always required for context
    blockUpdatesList: MessageBlock[] // Block updates remain required for this thunk's purpose
  ) =>
  async (dispatch: AppDispatch): Promise<void> => {
    const messageId = messageUpdates?.id

    if (messageUpdates && !messageId) {
      logger.error('[updateMessageAndUpdateBlocksThunk] Message ID is required.')
      return
    }

    try {
      // 1. 更新 Redux Store
      if (messageUpdates && messageId) {
        // oxlint-disable-next-line @typescript-eslint/no-unused-vars
        const { id: msgId, ...actualMessageChanges } = messageUpdates // Separate ID from actual changes

        // Only dispatch message update if there are actual changes beyond the ID
        if (Object.keys(actualMessageChanges).length > 0) {
          dispatch(
            newMessagesActions.updateMessage({
              topicId,
              messageId,
              updates: actualMessageChanges
            })
          )
        }
      }

      if (blockUpdatesList.length > 0) {
        dispatch(upsertManyBlocks(blockUpdatesList))
      }
      // Update message properties if provided
      if (messageUpdates && Object.keys(messageUpdates).length > 0 && messageId) {
        await updateMessage(topicId, messageId, messageUpdates)
      }
      // Update blocks if provided
      if (blockUpdatesList.length > 0) {
        await updateBlocks(blockUpdatesList)
      }

      dispatch(updateTopicUpdatedAt({ topicId }))
    } catch (error) {
      logger.error(`[updateMessageAndBlocksThunk] Failed to process updates for message ${messageId}:`, error as Error)
    }
  }

export const removeBlocksThunk =
  (topicId: string, messageId: string, blockIdsToRemove: string[]) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    if (!blockIdsToRemove.length) {
      logger.warn('[removeBlocksThunk] No block IDs provided to remove.')
      return
    }

    try {
      const state = getState()
      const message = state.messages.entities[messageId]

      if (!message) {
        logger.error(`[removeBlocksThunk] Message ${messageId} not found in state.`)
        return
      }
      const blockIdsToRemoveSet = new Set(blockIdsToRemove)

      const updatedBlockIds = (message.blocks || []).filter((id) => !blockIdsToRemoveSet.has(id))

      // 1. Update Redux state
      dispatch(
        newMessagesActions.updateMessage({
          topicId,
          messageId,
          updates: { blocks: updatedBlockIds }
        })
      )
      cleanupMultipleBlocks(dispatch, blockIdsToRemove)

      // 2. Update database - different handling for agent vs Dexie topics
      if (isAgentSessionTopicId(topicId)) {
        // For agent topics: dbService.updateMessage routes to AgentMessageDataSource
        await dbService.updateMessage(topicId, messageId, {
          blocks: updatedBlockIds
        })
      } else {
        // For Dexie topics: use transaction for atomicity
        const finalMessagesToSave = selectMessagesForTopic(getState(), topicId)
        await db.transaction('rw', db.topics, db.message_blocks, async () => {
          await db.topics.update(topicId, { messages: finalMessagesToSave })
          if (blockIdsToRemove.length > 0) {
            await db.message_blocks.bulkDelete(blockIdsToRemove)
          }
        })
      }

      dispatch(updateTopicUpdatedAt({ topicId }))
    } catch (error) {
      logger.error(`[removeBlocksThunk] Failed to remove blocks from message ${messageId}:`, error as Error)
      throw error
    }
  }

//以下内容从原 messageThunk.v2.ts 迁移过来，原文件已经删除
//原因：v2.ts并不是v2数据重构的一部分，而相关命名对v2重构造成重大误解，故两文件合并，以消除误解

/**
 * Load messages for a topic using unified DbService
 */
export const loadTopicMessagesThunk =
  (topicId: string, forceReload: boolean = false) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    const state = getState()

    dispatch(newMessagesActions.setCurrentTopicId(topicId))

    // Skip only after a real load has completed. Some UI paths create an
    // empty placeholder topic first, which must not be treated as cached data.
    if (!forceReload && state.messages.messageIdsByTopic[topicId] && state.messages.loadedByTopic[topicId]) {
      return
    }

    try {
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))

      // Unified call - no need to check isAgentSessionTopicId
      const { messages, blocks } = await dbService.fetchMessages(topicId)

      logger.silly('Loaded messages via DbService', {
        topicId,
        messageCount: messages.length,
        blockCount: blocks.length
      })

      // Update Redux state with fetched data
      if (blocks.length > 0) {
        dispatch(upsertManyBlocks(blocks))
      }
      dispatch(newMessagesActions.messagesReceived({ topicId, messages }))
      dispatch(newMessagesActions.setTopicFulfilled({ topicId, fulfilled: true }))
    } catch (error) {
      logger.error(`Failed to load messages for topic ${topicId}:`, error as Error)
      // Could dispatch an error action here if needed
    } finally {
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    }
  }

/**
 * Get raw topic data using unified DbService
 * Returns topic with messages array
 */
export const getRawTopic = async (topicId: string): Promise<{ id: string; messages: Message[] } | undefined> => {
  try {
    const rawTopic = await dbService.getRawTopic(topicId)
    logger.silly('Retrieved raw topic via DbService', {
      topicId,
      found: !!rawTopic
    })
    return rawTopic
  } catch (error) {
    logger.error('Failed to get raw topic:', { topicId, error })
    return undefined
  }
}

/**
 * Update file reference count
 * Only applies to Dexie data source, no-op for agent sessions
 */
export const updateFileCount = async (fileId: string, delta: number, deleteIfZero: boolean = false): Promise<void> => {
  try {
    // Pass all parameters to dbService, including deleteIfZero
    await dbService.updateFileCount(fileId, delta, deleteIfZero)
    logger.silly('Updated file count', { fileId, delta, deleteIfZero })
  } catch (error) {
    logger.error('Failed to update file count:', { fileId, delta, error })
    throw error
  }
}

/**
 * Delete a single message from database
 */
export const deleteMessageFromDB = async (topicId: string, messageId: string): Promise<void> => {
  try {
    await dbService.deleteMessage(topicId, messageId)
    logger.silly('Deleted message via DbService', { topicId, messageId })
  } catch (error) {
    logger.error('Failed to delete message:', { topicId, messageId, error })
    throw error
  }
}

/**
 * Delete multiple messages from database
 */
export const deleteMessagesFromDB = async (topicId: string, messageIds: string[]): Promise<void> => {
  try {
    await dbService.deleteMessages(topicId, messageIds)
    logger.silly('Deleted messages via DbService', {
      topicId,
      count: messageIds.length
    })
  } catch (error) {
    logger.error('Failed to delete messages:', { topicId, messageIds, error })
    throw error
  }
}

/**
 * Clear all messages from a topic
 */
export const clearMessagesFromDB = async (topicId: string): Promise<void> => {
  try {
    await dbService.clearMessages(topicId)
    logger.silly('Cleared all messages via DbService', { topicId })
  } catch (error) {
    logger.error('Failed to clear messages:', { topicId, error })
    throw error
  }
}

/**
 * Save a message and its blocks to database
 * Uses unified interface, no need for isAgentSessionTopicId check
 */
export const saveMessageAndBlocksToDB = async (
  topicId: string,
  message: Message,
  blocks: MessageBlock[],
  messageIndex: number = -1
): Promise<void> => {
  try {
    const blockIds = blocks.map((block) => block.id)
    const shouldSyncBlocks =
      blockIds.length > 0 && (!message.blocks || blockIds.some((id, index) => message.blocks?.[index] !== id))

    const messageWithBlocks = shouldSyncBlocks ? { ...message, blocks: blockIds } : message
    // Direct call without conditional logic, now with messageIndex
    await dbService.appendMessage(topicId, messageWithBlocks, blocks, messageIndex)
    logger.silly('Saved message and blocks via DbService', {
      topicId,
      messageId: message.id,
      blockCount: blocks.length,
      messageIndex
    })
  } catch (error) {
    logger.error('Failed to save message and blocks:', {
      topicId,
      messageId: message.id,
      error
    })
    throw error
  }
}

/**
 * Update a message in the database
 */
export const updateMessage = async (topicId: string, messageId: string, updates: Partial<Message>): Promise<void> => {
  try {
    await dbService.updateMessage(topicId, messageId, updates)
    logger.silly('Updated message via DbService', { topicId, messageId })
  } catch (error) {
    logger.error('Failed to update message:', { topicId, messageId, error })
    throw error
  }
}

/**
 * Update a single message block
 */
export const updateSingleBlock = async (blockId: string, updates: Partial<MessageBlock>): Promise<void> => {
  try {
    await dbService.updateSingleBlock(blockId, updates)
    logger.silly('Updated single block via DbService', { blockId })
  } catch (error) {
    logger.error('Failed to update single block:', { blockId, error })
    throw error
  }
}

/**
 * Bulk add message blocks (for new blocks)
 */
export const bulkAddBlocks = async (blocks: MessageBlock[]): Promise<void> => {
  try {
    await dbService.bulkAddBlocks(blocks)
    logger.silly('Bulk added blocks via DbService', { count: blocks.length })
  } catch (error) {
    logger.error('Failed to bulk add blocks:', { count: blocks.length, error })
    throw error
  }
}

/**
 * Update multiple message blocks (upsert operation)
 */
export const updateBlocks = async (blocks: MessageBlock[]): Promise<void> => {
  try {
    await dbService.updateBlocks(blocks)
    logger.silly('Updated blocks via DbService', { count: blocks.length })
  } catch (error) {
    logger.error('Failed to update blocks:', { count: blocks.length, error })
    throw error
  }
}

// ---------------------------------------------------------------------------
// IM Channel stream rendering
// ---------------------------------------------------------------------------
// Reuses the same BlockManager + AiSdkToChunkAdapter pipeline used for SSE
// streaming. IPC chunks are wrapped into a ReadableStream and fed into the
// existing stream processing infrastructure.
//
// Persistence is handled by the same saveUpdatesToDB / saveUpdatedBlockToDB
// functions used for normal agent messages (writes to SQLite via
// AgentMessageDataSource). When the renderer is watching, the backend skips
// its own persistHeadlessExchange to avoid duplicate writes.
// ---------------------------------------------------------------------------

export type ChannelStreamController = {
  pushChunk: (chunk: TextStreamPart<Record<string, any>>) => void
  complete: () => void
  error: (err: Error) => void
  assistantMessageId: string
  markUserMessageReceived: () => void
}

/**
 * Dispatches an IM channel user message to Redux and persists to DB.
 * Call this BEFORE setupChannelStream so the user message appears first.
 */
export const addChannelUserMessage = (
  dispatch: AppDispatch,
  topicId: string,
  agentId: string,
  text: string,
  images?: ChannelImageAttachment[],
  imagePaths?: string[]
): string => {
  const now = new Date().toISOString()
  const userMsgId = uuid()
  const blockId = uuid()

  const allBlocks: MessageBlock[] = [
    {
      id: blockId,
      messageId: userMsgId,
      type: MessageBlockType.MAIN_TEXT,
      content: text,
      status: MessageBlockStatus.SUCCESS,
      createdAt: now
    }
  ]

  if (images && images.length > 0) {
    for (const [index, img] of images.entries()) {
      allBlocks.push({
        id: uuid(),
        messageId: userMsgId,
        type: MessageBlockType.IMAGE,
        url: `data:${img.media_type};base64,${img.data}`,
        status: MessageBlockStatus.SUCCESS,
        createdAt: now,
        ...(imagePaths?.[index] ? { metadata: { channelImagePath: imagePaths[index] } } : {})
      } as MessageBlock)
    }
  }

  const userMessage: Message = {
    id: userMsgId,
    role: 'user',
    assistantId: agentId,
    topicId,
    createdAt: now,
    status: UserMessageStatus.SUCCESS,
    blocks: allBlocks.map((b) => b.id)
  }

  for (const block of allBlocks) {
    dispatch(upsertOneBlock(block))
  }
  dispatch(newMessagesActions.addMessage({ topicId, message: userMessage }))

  dbService.appendMessage(topicId, userMessage, allBlocks).catch((err) => {
    logger.error('Failed to persist channel user message', err as Error)
  })

  return userMsgId
}

/**
 * Sets up the streaming pipeline for rendering IM channel responses in real-time.
 * Creates the assistant message immediately — call addChannelUserMessage first
 * to ensure correct message ordering.
 */
export const setupChannelStream = (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  agentId: string,
  modelId?: string,
  askId?: string
): ChannelStreamController => {
  const model: Model | undefined =
    (modelId ? getModel(modelId) : undefined) ??
    (modelId ? { id: modelId, provider: '', name: '', group: '' } : undefined)
  const assistantMessage = createAssistantMessage(agentId, topicId, {
    ...(askId ? { askId } : {}),
    ...(model ? { modelId: model.id, model } : {})
  })
  dispatch(newMessagesActions.addMessage({ topicId, message: assistantMessage }))
  dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))
  dbService.appendMessage(topicId, assistantMessage, []).catch((err) => {
    logger.error('Failed to persist initial channel assistant message', err as Error)
  })

  let streamController: ReadableStreamDefaultController<TextStreamPart<Record<string, any>>> | null = null
  const stream = new ReadableStream<TextStreamPart<Record<string, any>>>({
    start(controller) {
      streamController = controller
    }
  })

  const assistant: Assistant = { id: agentId, name: '', prompt: '', topics: [], type: 'claude-code', model }

  const blockManager = new BlockManager({
    dispatch,
    getState,
    saveUpdatedBlockToDB,
    saveUpdatesToDB,
    assistantMsgId: assistantMessage.id,
    topicId,
    throttledBlockUpdate,
    cancelThrottledBlockUpdate
  })

  const callbacks = createCallbacks({
    blockManager,
    dispatch,
    getState,
    topicId,
    assistantMsgId: assistantMessage.id,
    saveUpdatesToDB,
    assistant
  })

  const streamProcessorCallbacks = createStreamProcessor(callbacks)
  void streamProcessorCallbacks({ type: ChunkType.LLM_RESPONSE_CREATED })

  const adapter = new AiSdkToChunkAdapter(streamProcessorCallbacks, [], false, false)
  let streamSettled = false
  let userMessageReceived = false
  const stallTimer = window.setTimeout(() => {
    if (streamSettled || !userMessageReceived) {
      return
    }

    const error = new Error('微信图片消息处理超时，请稍后重试，或在桌面端重新发送这张图片。')
    streamController?.enqueue({
      type: 'error',
      error
    } as TextStreamPart<Record<string, any>>)
    streamController?.close()
  }, AGENT_SESSION_CHANNEL_STALL_TIMEOUT_MS)

  adapter
    .processStream({
      fullStream: stream,
      text: Promise.resolve('')
    })
    .catch((err) => {
      logger.error('Channel stream processing failed', err as Error)
    })
    .finally(() => {
      streamSettled = true
      window.clearTimeout(stallTimer)
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    })

  return {
    assistantMessageId: assistantMessage.id,
    markUserMessageReceived() {
      userMessageReceived = true
    },
    pushChunk(chunk: TextStreamPart<Record<string, any>>) {
      streamController?.enqueue(chunk)
    },
    complete() {
      streamSettled = true
      window.clearTimeout(stallTimer)
      streamController?.close()
    },
    error(err: Error) {
      streamSettled = true
      window.clearTimeout(stallTimer)
      streamController?.error(err)
    }
  }
}
