import { loggerService } from '@logger'
import type {
  ExternalToolResult,
  GenerateImageResponse,
  MCPToolResponse,
  NormalToolResponse,
  WebSearchResponse
} from '@renderer/types'
import type { Chunk, ProviderMetadata } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'
import type { Response } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'

const logger = loggerService.withContext('StreamProcessingService')
type StreamCallbackResult = void | Promise<void>

// Define the structure for the callbacks that the StreamProcessor will invoke
export interface StreamProcessorCallbacks {
  // LLM response created
  onLLMResponseCreated?: () => StreamCallbackResult
  // Text content start
  onTextStart?: () => StreamCallbackResult
  // Text content chunk received
  onTextChunk?: (text: string, providerMetadata?: ProviderMetadata) => StreamCallbackResult
  // Full text content received
  onTextComplete?: (text: string, providerMetadata?: ProviderMetadata) => StreamCallbackResult
  // thinking content start
  onThinkingStart?: () => StreamCallbackResult
  // Thinking/reasoning content chunk received (e.g., from Claude)
  onThinkingChunk?: (text: string, thinking_millsec?: number) => StreamCallbackResult
  onThinkingComplete?: (text: string, thinking_millsec?: number) => StreamCallbackResult
  // A tool call response chunk (from MCP)
  onToolCallPending?: (toolResponse: MCPToolResponse | NormalToolResponse) => StreamCallbackResult
  onToolCallInProgress?: (toolResponse: MCPToolResponse | NormalToolResponse) => StreamCallbackResult
  onToolCallComplete?: (toolResponse: MCPToolResponse | NormalToolResponse) => StreamCallbackResult
  // Tool argument streaming (partial arguments during streaming)
  onToolArgumentStreaming?: (toolResponse: MCPToolResponse | NormalToolResponse) => StreamCallbackResult
  // External tool call in progress
  onExternalToolInProgress?: () => StreamCallbackResult
  // Citation data received (e.g., from Internet and  Knowledge Base)
  onExternalToolComplete?: (externalToolResult: ExternalToolResult) => StreamCallbackResult
  // LLM Web search in progress
  onLLMWebSearchInProgress?: () => StreamCallbackResult
  // LLM Web search complete
  onLLMWebSearchComplete?: (llmWebSearchResult: WebSearchResponse) => StreamCallbackResult
  // Get citation block ID
  getCitationBlockId?: () => string | null
  // Set citation block ID
  setCitationBlockId?: (blockId: string) => void
  // Image generation chunk received
  onImageCreated?: () => StreamCallbackResult
  onImageDelta?: (imageData: GenerateImageResponse) => StreamCallbackResult
  onImageGenerated?: (imageData?: GenerateImageResponse) => StreamCallbackResult
  onLLMResponseComplete?: (response?: Response) => StreamCallbackResult
  // Called when an error occurs during chunk processing
  onError?: (error: any) => StreamCallbackResult
  // Called when the entire stream processing is signaled as complete (success or failure)
  onComplete?: (status: AssistantMessageStatus, response?: Response) => StreamCallbackResult
  onVideoSearched?: (
    video?: { type: 'url' | 'path'; content: string },
    metadata?: Record<string, any>
  ) => StreamCallbackResult
  // Called when a block is created
  onBlockCreated?: () => StreamCallbackResult
  // Called when raw data is received (e.g., session_id updates from Agent SDK)
  onRawData?: (content: unknown, metadata?: Record<string, any>) => StreamCallbackResult
}

// Function to create a stream processor instance
export function createStreamProcessor(callbacks: StreamProcessorCallbacks = {}) {
  let processingQueue = Promise.resolve()
  let terminalState: 'open' | 'error' | 'complete' = 'open'

  // The returned function processes a single chunk or a final signal
  return (chunk: Chunk) => {
    processingQueue = processingQueue
      .then(async () => {
        if (terminalState !== 'open') {
          logger.debug('Ignoring stream chunk after terminal state', {
            terminalState,
            chunkType: chunk.type
          })
          return
        }

        const data = chunk
        // logger.debug('data: ', data)
        switch (data.type) {
          case ChunkType.BLOCK_COMPLETE: {
            break
          }
          case ChunkType.LLM_RESPONSE_CREATED: {
            if (callbacks.onLLMResponseCreated) await callbacks.onLLMResponseCreated()
            break
          }
          case ChunkType.TEXT_START: {
            if (callbacks.onTextStart) await callbacks.onTextStart()
            break
          }
          case ChunkType.TEXT_DELTA: {
            if (callbacks.onTextChunk) await callbacks.onTextChunk(data.text, data.providerMetadata)
            break
          }
          case ChunkType.TEXT_COMPLETE: {
            if (callbacks.onTextComplete) await callbacks.onTextComplete(data.text, data.providerMetadata)
            break
          }
          case ChunkType.THINKING_START: {
            if (callbacks.onThinkingStart) await callbacks.onThinkingStart()
            break
          }
          case ChunkType.THINKING_DELTA: {
            if (callbacks.onThinkingChunk) await callbacks.onThinkingChunk(data.text, data.thinking_millsec)
            break
          }
          case ChunkType.THINKING_COMPLETE: {
            if (callbacks.onThinkingComplete) await callbacks.onThinkingComplete(data.text, data.thinking_millsec)
            break
          }
          case ChunkType.MCP_TOOL_PENDING: {
            if (callbacks.onToolCallPending) {
              for (const toolResp of data.responses) {
                await callbacks.onToolCallPending(toolResp)
              }
            }
            break
          }
          case ChunkType.MCP_TOOL_IN_PROGRESS: {
            if (callbacks.onToolCallInProgress) {
              for (const toolResp of data.responses) {
                await callbacks.onToolCallInProgress(toolResp)
              }
            }
            break
          }
          case ChunkType.MCP_TOOL_COMPLETE: {
            if (callbacks.onToolCallComplete && data.responses.length > 0) {
              for (const toolResp of data.responses) {
                await callbacks.onToolCallComplete(toolResp)
              }
            }
            break
          }
          case ChunkType.MCP_TOOL_STREAMING: {
            if (callbacks.onToolArgumentStreaming) {
              for (const toolResp of data.responses) {
                await callbacks.onToolArgumentStreaming(toolResp)
              }
            }
            break
          }
          case ChunkType.EXTERNEL_TOOL_IN_PROGRESS: {
            if (callbacks.onExternalToolInProgress) await callbacks.onExternalToolInProgress()
            break
          }
          case ChunkType.EXTERNEL_TOOL_COMPLETE: {
            if (callbacks.onExternalToolComplete) await callbacks.onExternalToolComplete(data.external_tool)
            break
          }
          case ChunkType.LLM_WEB_SEARCH_IN_PROGRESS: {
            if (callbacks.onLLMWebSearchInProgress) await callbacks.onLLMWebSearchInProgress()
            break
          }
          case ChunkType.LLM_WEB_SEARCH_COMPLETE: {
            if (callbacks.onLLMWebSearchComplete) await callbacks.onLLMWebSearchComplete(data.llm_web_search)
            break
          }
          case ChunkType.IMAGE_CREATED: {
            if (callbacks.onImageCreated) await callbacks.onImageCreated()
            break
          }
          case ChunkType.IMAGE_DELTA: {
            if (callbacks.onImageDelta) await callbacks.onImageDelta(data.image)
            break
          }
          case ChunkType.IMAGE_COMPLETE: {
            if (callbacks.onImageGenerated) await callbacks.onImageGenerated(data.image)
            break
          }
          case ChunkType.LLM_RESPONSE_COMPLETE: {
            terminalState = 'complete'
            if (callbacks.onLLMResponseComplete) await callbacks.onLLMResponseComplete(data.response)
            if (callbacks.onComplete) await callbacks.onComplete(AssistantMessageStatus.SUCCESS, data.response)
            break
          }
          case ChunkType.ERROR: {
            terminalState = 'error'
            if (callbacks.onError) await callbacks.onError(data.error)
            break
          }
          case ChunkType.VIDEO_SEARCHED: {
            if (callbacks.onVideoSearched) await callbacks.onVideoSearched(data.video, data.metadata)
            break
          }
          case ChunkType.BLOCK_CREATED: {
            if (callbacks.onBlockCreated) await callbacks.onBlockCreated()
            break
          }
          case ChunkType.RAW: {
            if (callbacks.onRawData) await callbacks.onRawData(data.content, data.metadata)
            break
          }
          default: {
            // Handle unknown chunk types or log an error
            logger.warn(`Unknown chunk type: ${data.type}`)
          }
        }
      })
      .catch(async (error) => {
        logger.error('Error processing stream chunk:', error as Error)
        if (terminalState !== 'open') {
          return
        }
        terminalState = 'error'
        if (callbacks.onError) {
          await callbacks.onError(error)
        }
      })

    return processingQueue
  }
}
