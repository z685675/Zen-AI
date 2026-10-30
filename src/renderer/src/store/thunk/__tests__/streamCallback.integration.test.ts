import { combineReducers, configureStore } from '@reduxjs/toolkit'
import db from '@renderer/databases'
import { autoRenameTopic } from '@renderer/hooks/useTopic'
import { dbService } from '@renderer/services/db'
import { beginDiagnostic, getDiagnosticEvidence } from '@renderer/services/DiagnosticEvidenceService'
import { BlockManager } from '@renderer/services/messageStreaming/BlockManager'
import { createCallbacks } from '@renderer/services/messageStreaming/callbacks'
import { createStreamProcessor } from '@renderer/services/StreamProcessingService'
import { estimateMessagesUsage } from '@renderer/services/TokenService'
import rendererStore, { type AppDispatch } from '@renderer/store'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { messagesSlice } from '@renderer/store/newMessage'
import toolPermissionsReducer, { toolPermissionsActions } from '@renderer/store/toolPermissions'
import type { Assistant, Model } from '@renderer/types'
import type { Chunk } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { AgentTaskLimitError } from '@shared/agents/taskConcurrency'
import { DEFAULT_FUSION_AGENT_ID } from '@shared/config/agents'
import { NoOutputGeneratedError } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RootState } from '../../index'
import {
  addChannelUserMessage,
  appendAssistantResponseThunk,
  regenerateAssistantResponseThunk,
  resendMessageThunk,
  sendMessage,
  setupChannelStream
} from '../messageThunk'

vi.mock('@renderer/config/models', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    qwen3Model: {
      id: 'qwen',
      name: 'Qwen',
      provider: 'cherryai',
      group: 'Qwen'
    },
    SYSTEM_MODELS: {
      defaultModel: [{}, {}, {}]
    },
    getModelLogo: vi.fn(),
    isVisionModel: vi.fn(() => false),
    isFunctionCallingModel: vi.fn(() => false),
    isEmbeddingModel: vi.fn(() => false),
    isReasoningModel: vi.fn(() => false)
  }
})

vi.mock('@renderer/databases', () => ({
  default: {
    message_blocks: {
      bulkPut: vi.fn(),
      update: vi.fn(),
      bulkDelete: vi.fn(),
      put: vi.fn(),
      bulkAdd: vi.fn(),
      where: vi.fn().mockReturnValue({
        equals: vi.fn().mockReturnValue({
          modify: vi.fn()
        }),
        anyOf: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([])
        })
      })
    },
    topics: {
      get: vi.fn(),
      update: vi.fn(),
      where: vi.fn().mockReturnValue({
        equals: vi.fn().mockReturnValue({
          modify: vi.fn()
        })
      })
    },
    files: {
      where: vi.fn().mockReturnValue({
        equals: vi.fn().mockReturnValue({
          modify: vi.fn()
        })
      })
    },
    transaction: vi.fn((callback) => (typeof callback === 'function' ? callback() : Promise.resolve()))
  }
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    deleteFile: vi.fn(),
    addFile: vi.fn().mockResolvedValue({ id: 'file-1', path: '/tmp/file.png' }),
    getFileUrl: vi.fn().mockReturnValue('file:///tmp/file.png')
  }
}))

vi.mock('@renderer/services/NotificationService', () => ({
  NotificationService: {
    getInstance: vi.fn(() => ({
      send: vi.fn()
    }))
  }
}))

vi.mock('@renderer/services/EventService', () => ({
  EventEmitter: {
    emit: vi.fn(),
    on: vi.fn()
  },
  EVENT_NAMES: {
    MESSAGE_COMPLETE: 'MESSAGE_COMPLETE',
    SEND_MESSAGE: 'SEND_MESSAGE'
  }
}))

vi.mock('@renderer/utils/window', () => ({
  isOnHomePage: vi.fn(() => true),
  isFocused: vi.fn(() => true)
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  autoRenameTopic: vi.fn()
}))

vi.mock('@renderer/store/assistants', () => ({
  default: vi.fn((state = { entities: {}, ids: [] }) => state),
  updateTopicUpdatedAt: vi.fn(() => ({ type: 'UPDATE_TOPIC_UPDATED_AT' })),
  assistantsSlice: {
    name: 'assistants',
    reducer: vi.fn((state = { entities: {}, ids: [] }) => state),
    actions: {
      updateTopicUpdatedAt: vi.fn(() => ({ type: 'UPDATE_TOPIC_UPDATED_AT' }))
    }
  }
}))

vi.mock('@renderer/services/TokenService', () => ({
  estimateMessagesUsage: vi.fn(() =>
    Promise.resolve({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150
    })
  )
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: vi.fn(() => ({
    add: vi.fn((task) => task())
  })),
  waitForTopicQueue: vi.fn()
}))

vi.mock('@renderer/utils/messageUtils/find', () => ({
  default: {},
  findMainTextBlocks: vi.fn(() => []),
  getMainTextContent: vi.fn(() => 'Test content'),
  findAllBlocks: vi.fn(() => [])
}))

vi.mock('i18next', () => ({
  t: vi.fn((key) => key),
  default: {
    use: vi.fn().mockReturnThis(),
    init: vi.fn().mockResolvedValue(undefined),
    t: vi.fn((key) => key),
    changeLanguage: vi.fn().mockResolvedValue(undefined),
    language: 'en',
    languages: ['en', 'zh'],
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    store: {},
    services: {},
    options: {}
  }
}))

vi.mock('@renderer/utils/error', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    formatErrorMessage: vi.fn((error: Error) => error.message || 'Unknown error'),
    formatErrorMessageWithPrefix: vi.fn(
      (error: Error, prefix: string) => `${prefix}: ${error?.message || 'Unknown error'}`
    ),
    isAbortError: vi.fn((error: Error) => error.name === 'AbortError'),
    serializeError: vi.fn((error: Error) => ({
      name: error.name,
      message: error.message,
      stack: error.stack
    }))
  }
})

vi.mock('@renderer/utils', () => ({
  default: {},
  uuid: vi.fn(() => 'mock-uuid')
}))

const reducer = combineReducers({
  messages: messagesSlice.reducer,
  messageBlocks: messageBlocksSlice.reducer,
  toolPermissions: toolPermissionsReducer,
  topics: (state = { entities: {} }) => state
})

const createMockStore = () =>
  configureStore({
    reducer,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

const createMockCallbacks = (
  assistantMsgId: string,
  topicId: string,
  assistant: Assistant,
  dispatch: AppDispatch,
  getState: () => ReturnType<typeof reducer> & RootState
) =>
  createCallbacks({
    blockManager: new BlockManager({
      dispatch,
      getState,
      saveUpdatedBlockToDB: vi.fn(),
      saveUpdatesToDB: vi.fn(),
      assistantMsgId,
      topicId,
      throttledBlockUpdate: vi.fn(),
      cancelThrottledBlockUpdate: vi.fn()
    }),
    dispatch,
    getState,
    topicId,
    assistantMsgId,
    saveUpdatesToDB: vi.fn(),
    assistant
  })

const processChunks = async (chunks: Chunk[], callbacks: ReturnType<typeof createCallbacks>) => {
  const process = createStreamProcessor(callbacks)
  for (const chunk of chunks) {
    await process(chunk)
  }
}

describe('streamCallback integration', () => {
  let store: ReturnType<typeof createMockStore>
  let dispatch: AppDispatch
  let getState: () => ReturnType<typeof reducer> & RootState

  const topicId = 'topic-1'
  const assistantMsgId = 'assistant-message-1'
  const assistant: Assistant = {
    id: 'assistant-1',
    name: 'Test Assistant',
    model: {
      id: 'model-1',
      name: 'Test Model'
    } as Model,
    prompt: '',
    enableWebSearch: false,
    enableGenerateImage: false,
    knowledge_bases: [],
    topics: [],
    type: 'test'
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    store = createMockStore()
    dispatch = store.dispatch
    getState = store.getState as () => ReturnType<typeof reducer> & RootState

    Object.defineProperty(window, 'api', {
      value: {
        file: {
          saveBase64Image: vi.fn().mockResolvedValue({
            id: 'file-1',
            path: '/tmp/file.png'
          })
        }
      },
      configurable: true
    })

    store.dispatch(
      messagesSlice.actions.addMessage({
        topicId,
        message: {
          id: assistantMsgId,
          assistantId: assistant.id,
          role: 'assistant',
          topicId,
          blocks: [],
          status: AssistantMessageStatus.PENDING,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      })
    )
  })

  it('uses canonical channel IDs without appending duplicate rows or writing streamed blocks back to storage', async () => {
    vi.spyOn(rendererStore, 'getState').mockImplementation(getState)
    const append = vi.spyOn(dbService, 'appendMessage').mockResolvedValue(undefined)
    const update = vi.spyOn(dbService, 'updateMessage').mockResolvedValue(undefined)
    const channelTopic = 'agent-session:display-only'
    const userId = 'run:user'
    const answerId = 'run:assistant'
    const userOptions = { messageId: userId, persist: false as const }
    addChannelUserMessage(dispatch, channelTopic, 'agent-channel', '你好', undefined, undefined, userOptions)
    addChannelUserMessage(dispatch, channelTopic, 'agent-channel', '你好', undefined, undefined, userOptions)
    const stream = setupChannelStream(dispatch, getState, channelTopic, 'agent-channel', undefined, userId, {
      messageId: answerId,
      persist: false
    })
    stream.pushChunk({ type: 'text-start', id: 'text' })
    stream.pushChunk({ type: 'text-delta', id: 'text', text: '第一段' })
    stream.pushChunk({ type: 'text-delta', id: 'text', text: '第二段' })
    stream.pushChunk({ type: 'text-end', id: 'text' })
    stream.complete()
    await stream.settled
    const replay = setupChannelStream(dispatch, getState, channelTopic, 'agent-channel', undefined, userId, {
      messageId: answerId,
      persist: false
    })
    replay.complete()
    await replay.settled
    expect(getState().messages.messageIdsByTopic[channelTopic]).toEqual([userId, answerId])
    expect(getState().messages.entities[answerId].askId).toBe(userId)
    expect(append).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(db.message_blocks.update).not.toHaveBeenCalled()
    expect(db.message_blocks.bulkPut).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'blocks all old execution thunks without rewriting history (developer=%s)',
    async (developer) => {
      const legacyTopicId = 'agent-session:legacy-read-only'
      const legacyAssistant = { ...assistant, id: DEFAULT_FUSION_AGENT_ID, type: 'agent-session' }
      const user = {
        id: 'legacy-user',
        assistantId: legacyAssistant.id,
        role: 'user',
        topicId: legacyTopicId,
        blocks: ['legacy-user-block'],
        status: 'success',
        createdAt: '2026-10-01T12:00:00.000Z'
      } as any
      const answer = {
        ...user,
        id: 'legacy-answer',
        role: 'assistant',
        askId: user.id,
        blocks: ['legacy-answer-block']
      }
      store.dispatch(messagesSlice.actions.addMessage({ topicId: legacyTopicId, message: user }))
      store.dispatch(messagesSlice.actions.addMessage({ topicId: legacyTopicId, message: answer }))
      const before = structuredClone(store.getState().messages)
      const readState = () => ({ ...getState(), settings: { enableDeveloperMode: developer } }) as RootState
      const info = vi.fn()
      Object.defineProperty(window, 'toast', { value: { info }, configurable: true })
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      await sendMessage(user, [], legacyAssistant, legacyTopicId)(dispatch, readState)
      await resendMessageThunk(legacyTopicId, user, legacyAssistant)(dispatch, readState)
      await regenerateAssistantResponseThunk(legacyTopicId, answer, legacyAssistant)(dispatch, readState)
      await appendAssistantResponseThunk(
        legacyTopicId,
        answer.id,
        assistant.model,
        legacyAssistant
      )(dispatch, readState)
      expect(info).toHaveBeenCalledTimes(4)
      expect(store.getState().messages).toEqual(before)
      expect(db.message_blocks.bulkDelete).not.toHaveBeenCalled()
      expect(db.topics.update).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    }
  )

  it.each(['success', 'error'] as const)(
    'persists content-free OpenCode usage diagnostics alongside terminal timing on %s, without estimating native zero counters',
    async (outcome) => {
      const data = {
        version: 1,
        providerId: 'local',
        modelId: 'test',
        usage: {},
        observedRequests: 1,
        reportedRequests: 0,
        inputReports: 0,
        outputReports: 0,
        cacheReadReports: 0,
        cacheWriteReports: 0,
        incompleteRequests: 0,
        performance: {
          outcome: outcome === 'success' ? 'completed' : 'failed',
          totalMs: 10,
          preparationMs: 0,
          upstreamRequests: 1,
          upstreamHeaderWaitMs: 1,
          upstreamRequestMs: 5,
          retryEvents: 0,
          toolCalls: 0,
          completedToolObservedMs: 0,
          unfinishedTools: 0
        }
      }
      const save = vi.fn().mockResolvedValue(undefined)
      const testCallbacks = createCallbacks({
        blockManager: new BlockManager({
          dispatch,
          getState,
          saveUpdatedBlockToDB: vi.fn(),
          saveUpdatesToDB: save,
          assistantMsgId,
          topicId,
          throttledBlockUpdate: vi.fn(),
          cancelThrottledBlockUpdate: vi.fn()
        }),
        dispatch,
        getState,
        topicId,
        assistantMsgId,
        saveUpdatesToDB: save,
        assistant
      })
      await processChunks(
        [{ type: ChunkType.RAW, content: { type: 'opencode_diagnostics', diagnostics: data } }],
        testCallbacks
      )
      expect(getState().messages.entities[assistantMsgId].providerMetadata?.opencodeDiagnostics).toEqual(data)
      expect(save).not.toHaveBeenCalled()
      if (outcome === 'success')
        await testCallbacks.onComplete(AssistantMessageStatus.SUCCESS, {
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        })
      else await testCallbacks.onError(new Error('test failure') as any)
      const result = getState().messages.entities[assistantMsgId]
      expect(result.providerMetadata?.opencodeDiagnostics).toEqual(data)
      expect(result.providerMetadata?.responseTiming?.outcome).toBe(outcome === 'success' ? 'completed' : 'failed')
      expect(estimateMessagesUsage).not.toHaveBeenCalled()
      expect(save.mock.calls.at(-1)?.[2].providerMetadata).toMatchObject({
        opencodeDiagnostics: data,
        responseTiming: expect.any(Object)
      })
    }
  )

  it('persists a sanitized quota notice with terminal metadata without adding text to the answer', async () => {
    const result = {
      model: 'gpt-test',
      date: '2026-10-29',
      current_date: '2026-10-29',
      limit: 100,
      used: 120,
      exhausted: true,
      extra_allowed: false,
      pending: false
    }
    const save = vi.fn().mockResolvedValue(undefined)
    const callbacks = createCallbacks({
      blockManager: new BlockManager({
        dispatch,
        getState,
        saveUpdatedBlockToDB: vi.fn(),
        saveUpdatesToDB: save,
        assistantMsgId,
        topicId,
        throttledBlockUpdate: vi.fn(),
        cancelThrottledBlockUpdate: vi.fn()
      }),
      dispatch,
      getState,
      topicId,
      assistantMsgId,
      saveUpdatesToDB: save,
      assistant
    })
    const blocks = [...getState().messages.entities[assistantMsgId].blocks]
    await processChunks(
      [
        {
          type: ChunkType.RAW,
          content: { type: 'model_daily_quota', results: [{ ...result, permit: 'private-secret' }, null] }
        }
      ],
      callbacks
    )
    expect(getState().messages.entities[assistantMsgId].providerMetadata?.modelDailyQuota).toEqual({
      results: [result]
    })
    expect(save).not.toHaveBeenCalled()
    await callbacks.onComplete(AssistantMessageStatus.SUCCESS, {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })
    const message = getState().messages.entities[assistantMsgId]
    expect(message.blocks).toEqual(blocks)
    expect(message.status).toBe(AssistantMessageStatus.SUCCESS)
    expect(save.mock.calls.at(-1)?.[2].providerMetadata).toMatchObject({
      modelDailyQuota: { results: [result] },
      responseTiming: expect.any(Object)
    })
    expect(JSON.stringify(save.mock.calls)).not.toContain('private-secret')
  })

  it('handles a complete text streaming flow', async () => {
    const callbacks = createMockCallbacks(assistantMsgId, topicId, assistant, dispatch, getState)
    const chunks: Chunk[] = [
      { type: ChunkType.LLM_RESPONSE_CREATED },
      { type: ChunkType.TEXT_START },
      { type: ChunkType.TEXT_DELTA, text: 'Hello ' },
      { type: ChunkType.TEXT_DELTA, text: 'Hello world!' },
      { type: ChunkType.TEXT_COMPLETE, text: 'Hello world!' },
      {
        type: ChunkType.BLOCK_COMPLETE,
        response: {
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          metrics: { completion_tokens: 50, time_completion_millsec: 1000 }
        }
      },
      {
        type: ChunkType.LLM_RESPONSE_COMPLETE,
        response: {
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          metrics: { completion_tokens: 50, time_completion_millsec: 1000 }
        }
      }
    ]

    await processChunks(chunks, callbacks)

    const state = getState()
    const blocks = Object.values(state.messageBlocks.entities)
    const textBlock = blocks.find((block) => block.type === MessageBlockType.MAIN_TEXT)
    const message = state.messages.entities[assistantMsgId]

    expect(textBlock).toBeDefined()
    expect(textBlock?.content).toBe('Hello world!')
    expect(textBlock?.status).toBe(MessageBlockStatus.SUCCESS)
    expect(message?.status).toBe(AssistantMessageStatus.SUCCESS)
    expect(message?.usage?.total_tokens).toBe(150)
    expect(autoRenameTopic).toHaveBeenCalledWith(assistant, topicId)
  })

  it('records first reasoning and first answer separately, once, without capturing their content', async () => {
    beginDiagnostic(assistantMsgId, {})
    const callbacks = createMockCallbacks(assistantMsgId, topicId, assistant, dispatch, getState)
    await processChunks(
      [
        { type: ChunkType.LLM_RESPONSE_CREATED },
        { type: ChunkType.THINKING_START },
        { type: ChunkType.THINKING_DELTA, text: 'PRIVATE_REASONING' },
        { type: ChunkType.THINKING_COMPLETE, text: 'PRIVATE_REASONING' },
        { type: ChunkType.TEXT_START },
        { type: ChunkType.TEXT_DELTA, text: 'PRIVATE_ANSWER' },
        { type: ChunkType.TEXT_COMPLETE, text: 'PRIVATE_ANSWER' }
      ],
      callbacks
    )
    const events = getDiagnosticEvidence(assistantMsgId)!.events.filter(
      (event) => event.stage === 'response' && ['first-content', 'first-text'].includes(event.event)
    )
    expect(events.map((event) => event.event)).toEqual(['first-content', 'first-text'])
    expect(JSON.stringify(events)).not.toContain('PRIVATE_')
    expect(
      Object.values(getState().messageBlocks.entities).some(
        (block) => 'content' in block && block.content === 'PRIVATE_ANSWER'
      )
    ).toBe(true)
  })

  it('persists an SDK no-output error and refuses a later success signal', async () => {
    const callbacks = createMockCallbacks(assistantMsgId, topicId, assistant, dispatch, getState)
    await processChunks(
      [
        { type: ChunkType.LLM_RESPONSE_CREATED },
        { type: ChunkType.ERROR, error: new NoOutputGeneratedError() },
        { type: ChunkType.LLM_RESPONSE_COMPLETE }
      ],
      callbacks
    )
    const message = getState().messages.entities[assistantMsgId]
    expect(message.status).toBe(AssistantMessageStatus.ERROR)
    expect(message.providerMetadata?.responseTiming?.outcome).toBe('failed')
    expect(
      Object.values(getState().messageBlocks.entities).some((block) => block.type === MessageBlockType.ERROR)
    ).toBe(true)
    expect(getState().messages.loadingByTopic[topicId]).toBeFalsy()
  })

  it.each([ChunkType.MCP_TOOL_PENDING, ChunkType.MCP_TOOL_STREAMING, ChunkType.MCP_TOOL_IN_PROGRESS])(
    'records the first assistant tool event %s, not its final answer, as first response',
    async (type) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime('2026-10-25T01:30:00Z')
      let clock = 0
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      beginDiagnostic(assistantMsgId, {})
      const callbacks = createMockCallbacks(
        assistantMsgId,
        topicId,
        { ...assistant, type: 'agent-session' },
        dispatch,
        getState
      )
      const processor = createStreamProcessor(callbacks)
      await processor({ type: ChunkType.LLM_RESPONSE_CREATED })
      await processor({ type: ChunkType.THINKING_START })
      clock = 2000
      vi.setSystemTime('2026-10-25T01:30:02Z')
      const tool = {
        id: 'tool-1',
        tool: { name: 'create_file' },
        arguments: { secret: 'PRIVATE_INPUT' },
        status: 'pending'
      } as any
      await processor({ type, responses: [tool] })
      clock = 10_000
      await processor({ type, responses: [tool] })
      clock = 900_000
      vi.setSystemTime('2026-10-25T01:45:00Z')
      await processor({ type: ChunkType.TEXT_START })
      await processor({ type: ChunkType.TEXT_COMPLETE, text: 'Finished creating the files' })
      clock = 903_000
      vi.setSystemTime('2026-10-25T01:45:03Z')
      await processor({ type: ChunkType.LLM_RESPONSE_COMPLETE })
      expect(getState().messages.entities[assistantMsgId].providerMetadata?.responseTiming).toMatchObject({
        firstTokenMs: 2000,
        elapsedMs: 903_000,
        finishedAt: '2026-10-25T01:45:03.000Z',
        outcome: 'completed'
      })
      const events = getDiagnosticEvidence(assistantMsgId)!.events.filter(
        (event) => event.stage === 'response' && ['first-content', 'first-text'].includes(event.event)
      )
      expect(events.map((event) => [event.event, event.at])).toEqual([
        ['first-content', '2026-10-25T01:30:02.000Z'],
        ['first-text', '2026-10-25T01:45:00.000Z']
      ])
      expect(JSON.stringify(events)).not.toContain('PRIVATE_INPUT')
    }
  )

  it.each(['AbortError', 'Error'])(
    'retains the first tool response when an assistant later stops with %s',
    async (name) => {
      let clock = 0
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      const callbacks = createMockCallbacks(
        assistantMsgId,
        topicId,
        { ...assistant, type: 'agent-session' },
        dispatch,
        getState
      )
      const processor = createStreamProcessor(callbacks)
      await processor({ type: ChunkType.LLM_RESPONSE_CREATED })
      clock = 1500
      await processor({
        type: ChunkType.MCP_TOOL_PENDING,
        responses: [{ id: 'stopped-tool', tool: { name: 'create_file' }, arguments: {}, status: 'pending' } as any]
      })
      clock = 5000
      await processor({ type: ChunkType.ERROR, error: Object.assign(new Error('stopped'), { name }) })
      expect(getState().messages.entities[assistantMsgId].providerMetadata?.responseTiming).toMatchObject({
        firstTokenMs: 1500,
        elapsedMs: 5000,
        outcome: name === 'AbortError' ? 'cancelled' : 'failed'
      })
    }
  )

  it('keeps AI chat timing based on text instead of changing its semantics for tools', async () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const callbacks = createMockCallbacks(assistantMsgId, topicId, assistant, dispatch, getState)
    const processor = createStreamProcessor(callbacks)
    await processor({ type: ChunkType.LLM_RESPONSE_CREATED })
    clock = 1000
    await processor({
      type: ChunkType.MCP_TOOL_PENDING,
      responses: [{ id: 'chat-tool', tool: { name: 'read_document' }, arguments: {}, status: 'pending' } as any]
    })
    clock = 4000
    await processor({ type: ChunkType.TEXT_COMPLETE, text: 'Answer' })
    clock = 5000
    await processor({ type: ChunkType.LLM_RESPONSE_COMPLETE })
    expect(getState().messages.entities[assistantMsgId].providerMetadata?.responseTiming).toMatchObject({
      firstTokenMs: 4000,
      elapsedMs: 5000
    })
  })

  it('records full-round timing, preserves other metadata and uses the actual finished timestamp', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-10-11T01:30:00Z')
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    store.dispatch(
      messagesSlice.actions.updateMessage({
        topicId,
        messageId: assistantMsgId,
        updates: {
          providerMetadata: { agentSessionSync: { target: 'wechat', status: 'synced', runId: 'mirror-run-1' } }
        }
      })
    )
    const callbacks = createMockCallbacks(assistantMsgId, topicId, assistant, dispatch, getState)
    const processor = createStreamProcessor(callbacks)
    await processor({ type: ChunkType.LLM_RESPONSE_CREATED })
    await processor({ type: ChunkType.THINKING_START })
    clock = 1500
    await processor({ type: ChunkType.THINKING_DELTA, text: 'thinking' })
    await processor({ type: ChunkType.THINKING_COMPLETE, text: 'thinking' })
    clock = 3000
    await processor({ type: ChunkType.TEXT_START })
    await processor({ type: ChunkType.TEXT_DELTA, text: 'done' })
    await processor({ type: ChunkType.TEXT_COMPLETE, text: 'done' })
    clock = 6500
    vi.setSystemTime('2026-10-11T01:30:06.500Z')
    await processor({
      type: ChunkType.LLM_RESPONSE_COMPLETE,
      response: { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }
    })
    const message = getState().messages.entities[assistantMsgId]
    expect(message.updatedAt).toBe('2026-10-11T01:30:06.500Z')
    expect(message.providerMetadata?.agentSessionSync).toEqual({
      target: 'wechat',
      status: 'synced',
      runId: 'mirror-run-1'
    })
    expect(message.providerMetadata?.responseTiming).toEqual({
      startedAt: '2026-10-11T01:30:00.000Z',
      finishedAt: '2026-10-11T01:30:06.500Z',
      firstTokenMs: 1500,
      elapsedMs: 6500,
      outcome: 'completed'
    })
    clock = 10_000
    await processor({ type: ChunkType.ERROR, error: new Error('late error') })
    expect(getState().messages.entities[assistantMsgId].providerMetadata?.responseTiming?.elapsedMs).toBe(6500)
  })

  it.each(['AbortError', 'Error'])(
    'records %s termination without inventing a first token or success',
    async (name) => {
      let clock = 0
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      const callbacks = createMockCallbacks(assistantMsgId, topicId, assistant, dispatch, getState)
      const processor = createStreamProcessor(callbacks)
      await processor({ type: ChunkType.LLM_RESPONSE_CREATED })
      clock = 2300
      await processor({ type: ChunkType.ERROR, error: Object.assign(new Error('stopped'), { name }) })
      expect(getState().messages.entities[assistantMsgId].providerMetadata?.responseTiming).toMatchObject({
        firstTokenMs: undefined,
        elapsedMs: 2300,
        outcome: name === 'AbortError' ? 'cancelled' : 'failed'
      })
    }
  )

  it('creates only one error block and ignores late terminal chunks', async () => {
    const callbacks = createMockCallbacks(assistantMsgId, topicId, assistant, dispatch, getState)
    const chunks: Chunk[] = [
      { type: ChunkType.LLM_RESPONSE_CREATED },
      { type: ChunkType.ERROR, error: new Error('connection interrupted') },
      { type: ChunkType.ERROR, error: new Error('duplicate connection interrupted') },
      {
        type: ChunkType.LLM_RESPONSE_COMPLETE,
        response: {
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          metrics: { completion_tokens: 0, time_completion_millsec: 0 }
        }
      }
    ]

    await processChunks(chunks, callbacks)

    const state = getState()
    const errorBlocks = Object.values(state.messageBlocks.entities).filter(
      (block) => block.type === MessageBlockType.ERROR
    )
    const message = state.messages.entities[assistantMsgId]

    expect(errorBlocks).toHaveLength(1)
    expect(message?.status).toBe(AssistantMessageStatus.ERROR)
    expect(autoRenameTopic).toHaveBeenCalledWith(assistant, topicId)
  })

  it('handles a thinking flow', async () => {
    const callbacks = createMockCallbacks(assistantMsgId, topicId, assistant, dispatch, getState)
    const chunks: Chunk[] = [
      { type: ChunkType.LLM_RESPONSE_CREATED },
      { type: ChunkType.THINKING_START },
      { type: ChunkType.THINKING_DELTA, text: 'Let me think...', thinking_millsec: 1000 },
      { type: ChunkType.THINKING_DELTA, text: 'Final thoughts', thinking_millsec: 3000 },
      { type: ChunkType.THINKING_COMPLETE, text: 'Final thoughts' },
      { type: ChunkType.BLOCK_COMPLETE },
      {
        type: ChunkType.LLM_RESPONSE_COMPLETE,
        response: {
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          metrics: { completion_tokens: 0, time_completion_millsec: 1000 }
        }
      }
    ]

    await processChunks(chunks, callbacks)

    const state = getState()
    const blocks = Object.values(state.messageBlocks.entities)
    const thinkingBlock = blocks.find((block) => block.type === MessageBlockType.THINKING)

    expect(thinkingBlock).toBeDefined()
    expect(thinkingBlock?.content).toBe('Final thoughts')
    expect(thinkingBlock?.status).toBe(MessageBlockStatus.SUCCESS)
    expect(typeof (thinkingBlock as any)?.thinking_millsec).toBe('number')
  })

  it('leaves a running task permission untouched when a new task is denied by capacity', async () => {
    beginDiagnostic(assistantMsgId, {})
    store.dispatch(
      toolPermissionsActions.requestReceived({
        requestId: 'other-permission',
        toolName: 'Write',
        toolId: 'Write',
        toolCallId: 'other-call',
        requiresPermissions: true,
        input: {},
        inputPreview: '',
        createdAt: Date.now(),
        suggestions: []
      })
    )
    const callbacks = createMockCallbacks(assistantMsgId, topicId, assistant, dispatch, getState)
    await processChunks([{ type: ChunkType.ERROR, error: new AgentTaskLimitError(1, 1) }], callbacks)
    expect(getState().toolPermissions.requests['other-permission']?.status).toBe('pending')
    expect(getDiagnosticEvidence(assistantMsgId)?.events).toContainEqual(
      expect.objectContaining({
        stage: 'preparation',
        event: 'blocked',
        details: expect.objectContaining({ phase: 'local-task-admission', limit: 1 })
      })
    )
  })

  it('removes only the stopped message pending permission, not another task or invoking entry', async () => {
    for (const [requestId, toolCallId] of [
      ['own-permission', 'own-call'],
      ['other-permission', 'other-call'],
      ['invoking-permission', 'own-invoking']
    ]) {
      store.dispatch(
        toolPermissionsActions.requestReceived({
          requestId,
          toolName: 'Write',
          toolId: 'Write',
          toolCallId,
          requiresPermissions: true,
          input: {},
          inputPreview: '',
          createdAt: Date.now(),
          suggestions: []
        })
      )
    }
    store.dispatch(
      toolPermissionsActions.requestResolved({
        requestId: 'invoking-permission',
        behavior: 'allow',
        reason: 'response'
      })
    )
    store.dispatch(
      messageBlocksSlice.actions.upsertManyBlocks([
        {
          id: 'own-tool-block',
          messageId: assistantMsgId,
          type: MessageBlockType.TOOL,
          toolId: 'own-call',
          status: MessageBlockStatus.PENDING,
          createdAt: new Date().toISOString()
        },
        {
          id: 'invoking-tool-block',
          messageId: assistantMsgId,
          type: MessageBlockType.TOOL,
          toolId: 'own-invoking',
          status: MessageBlockStatus.PENDING,
          createdAt: new Date().toISOString()
        }
      ])
    )
    store.dispatch(
      messagesSlice.actions.updateMessage({
        topicId,
        messageId: assistantMsgId,
        updates: { blocks: ['own-tool-block', 'invoking-tool-block'] }
      })
    )
    const callbacks = createMockCallbacks(assistantMsgId, topicId, assistant, dispatch, getState)
    await processChunks([{ type: ChunkType.ERROR, error: new DOMException('Stopped', 'AbortError') }], callbacks)
    const requests = getState().toolPermissions.requests
    expect(requests['own-permission']).toBeUndefined()
    expect(requests['other-permission']?.status).toBe('pending')
    expect(requests['invoking-permission']?.status).toBe('invoking')
  })
})
