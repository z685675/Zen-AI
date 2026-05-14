import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { BlockManager } from '@renderer/services/messageStreaming/BlockManager'
import { createCallbacks } from '@renderer/services/messageStreaming/callbacks'
import { createStreamProcessor } from '@renderer/services/StreamProcessingService'
import type { AppDispatch } from '@renderer/store'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { messagesSlice } from '@renderer/store/newMessage'
import type { Assistant, Model } from '@renderer/types'
import type { Chunk } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RootState } from '../../index'

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
    formatErrorMessageWithPrefix: vi.fn((error: Error, prefix: string) => `${prefix}: ${error?.message || 'Unknown error'}`),
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
    process(chunk)
    await new Promise((resolve) => setTimeout(resolve, 0))
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

  it('handles a complete text streaming flow', async () => {
    const callbacks = createMockCallbacks(assistantMsgId, topicId, assistant, dispatch, getState)
    const chunks: Chunk[] = [
      { type: ChunkType.LLM_RESPONSE_CREATED },
      { type: ChunkType.TEXT_START },
      { type: ChunkType.TEXT_DELTA, text: 'Hello ' },
      { type: ChunkType.TEXT_DELTA, text: 'Hello world!' },
      { type: ChunkType.TEXT_COMPLETE, text: 'Hello world!' },
      {
        type: ChunkType.LLM_RESPONSE_COMPLETE,
        response: {
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          metrics: { completion_tokens: 50, time_completion_millsec: 1000 }
        }
      },
      {
        type: ChunkType.BLOCK_COMPLETE,
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
  })

  it('handles a thinking flow', async () => {
    const callbacks = createMockCallbacks(assistantMsgId, topicId, assistant, dispatch, getState)
    const chunks: Chunk[] = [
      { type: ChunkType.LLM_RESPONSE_CREATED },
      { type: ChunkType.THINKING_START },
      { type: ChunkType.THINKING_DELTA, text: 'Let me think...', thinking_millsec: 1000 },
      { type: ChunkType.THINKING_DELTA, text: 'Final thoughts', thinking_millsec: 3000 },
      { type: ChunkType.THINKING_COMPLETE, text: 'Final thoughts' },
      { type: ChunkType.BLOCK_COMPLETE }
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
})
