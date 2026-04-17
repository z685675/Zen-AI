/**
 * AI SDK 鍒?Zen AI Chunk 閫傞厤鍣? * 鐢ㄤ簬灏?AI SDK 鐨?fullStream 杞崲涓?Zen AI 鐨?chunk 鏍煎紡
 */

import { loggerService } from '@logger'
import type { AISDKWebSearchResult, MCPTool, WebSearchResults, WebSearchSource } from '@renderer/types'
import { WEB_SEARCH_SOURCE } from '@renderer/types'
import type { Chunk, ProviderMetadata } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'
import { ProviderSpecificError } from '@renderer/types/provider-specific-error'
import { formatErrorMessage, isAbortError } from '@renderer/utils/error'
import type { IdleTimeoutHandle } from '@renderer/utils/IdleTimeoutController'
import { convertLinks, flushLinkConverterBuffer } from '@renderer/utils/linkConverter'
import type { ClaudeCodeRawValue } from '@shared/agents/claudecode/types'
import { AISDKError, type TextStreamPart, type ToolSet } from 'ai'

import { ToolCallChunkHandler } from './handleToolCallChunk'

const logger = loggerService.withContext('AiSdkToChunkAdapter')

/**
 * AI SDK 鍒?Zen AI Chunk 閫傞厤鍣ㄧ被
 * 澶勭悊 fullStream 鍒?Zen AI chunk 鐨勮浆鎹? */
export class AiSdkToChunkAdapter {
  toolCallHandler: ToolCallChunkHandler
  private accumulate: boolean | undefined
  private isFirstChunk = true
  private enableWebSearch: boolean = false
  private onSessionUpdate?: (sessionId: string) => void
  private responseStartTimestamp: number | null = null
  private firstTokenTimestamp: number | null = null
  private hasTextContent = false
  private getSessionWasCleared?: () => boolean
  private providerId?: string
  private idleTimeout?: IdleTimeoutHandle

  constructor(
    private onChunk: (chunk: Chunk) => void,
    mcpTools: MCPTool[] = [],
    accumulate?: boolean,
    enableWebSearch?: boolean,
    onSessionUpdate?: (sessionId: string) => void,
    getSessionWasCleared?: () => boolean,
    providerId?: string,
    idleTimeout?: IdleTimeoutHandle
  ) {
    this.toolCallHandler = new ToolCallChunkHandler(onChunk, mcpTools)
    this.accumulate = accumulate
    this.enableWebSearch = enableWebSearch || false
    this.onSessionUpdate = onSessionUpdate
    this.getSessionWasCleared = getSessionWasCleared
    this.providerId = providerId
    this.idleTimeout = idleTimeout
  }

  private markFirstTokenIfNeeded() {
    if (this.firstTokenTimestamp === null && this.responseStartTimestamp !== null) {
      this.firstTokenTimestamp = Date.now()
    }
  }

  private resetTimingState() {
    this.responseStartTimestamp = null
    this.firstTokenTimestamp = null
  }

  /**
   * 澶勭悊 AI SDK 娴佺粨鏋?   * @param aiSdkResult AI SDK 鐨勬祦缁撴灉瀵硅薄
   * @returns 鏈€缁堢殑鏂囨湰鍐呭
   */
  async processStream(aiSdkResult: any): Promise<string> {
    // The stream is the single source of truth for abort handling.
    // Both AI SDK (resilient stream) and the agent pipeline (withAbortStreamPart)
    // guarantee: abort 鈫?enqueue { type: 'abort' } 鈫?close gracefully.
    // convertAndEmitChunk processes the abort part and emits ChunkType.ERROR 鈫?onError.
    if (aiSdkResult.fullStream) {
      await this.readFullStream(aiSdkResult.fullStream)
    }

    try {
      return await aiSdkResult.text
    } catch (error: any) {
      // The text promise rejects when no steps completed (e.g. abort during thinking).
      // The abort was already handled via the 'abort' stream part above.
      if (isAbortError(error)) {
        return ''
      }
      throw error
    }
  }

  /**
   * 璇诲彇 fullStream 骞惰浆鎹负 Zen AI chunks
   * @param fullStream AI SDK 鐨?fullStream (ReadableStream)
   */
  private async readFullStream(fullStream: ReadableStream<TextStreamPart<ToolSet>>) {
    const reader = fullStream.getReader()
    const final = {
      text: '',
      reasoningContent: '',
      webSearchResults: [],
      reasoningId: '',
      providerMetadata: undefined as ProviderMetadata | undefined
    }
    this.resetTimingState()
    this.responseStartTimestamp = Date.now()
    // Reset state at the start of stream
    this.isFirstChunk = true
    this.hasTextContent = false

    try {
      while (true) {
        const { done, value } = await reader.read()

        // Reset idle timeout on every chunk received from the stream
        this.idleTimeout?.reset()

        if (done) {
          // Flush any remaining content from link converter buffer if web search is enabled
          if (this.enableWebSearch) {
            const remainingText = flushLinkConverterBuffer()
            if (remainingText) {
              this.markFirstTokenIfNeeded()
              this.onChunk({
                type: ChunkType.TEXT_DELTA,
                text: remainingText
              })
            }
          }
          break
        }

        // 杞崲骞跺彂閫?chunk
        this.convertAndEmitChunk(value, final)
      }
    } finally {
      reader.releaseLock()
      this.resetTimingState()
      // Clean up the idle timeout timer when the stream ends
      this.idleTimeout?.cleanup()
    }
  }

  /**
   * 濡傛灉鏈夌疮绉殑鎬濊€冨唴瀹癸紝鍙戦€?THINKING_COMPLETE chunk 骞舵竻绌?   * @param final 鍖呭惈 reasoningContent 鐨勭姸鎬佸璞?   * @returns 鏄惁鍙戦€佷簡 THINKING_COMPLETE chunk
   */
  private emitThinkingCompleteIfNeeded(final: { reasoningContent: string; [key: string]: any }) {
    if (final.reasoningContent) {
      this.onChunk({
        type: ChunkType.THINKING_COMPLETE,
        text: final.reasoningContent
      })
      final.reasoningContent = ''
    }
  }

  /**
   * 杞崲 AI SDK chunk 涓?Zen AI chunk 骞惰皟鐢ㄥ洖璋?   * @param chunk AI SDK 鐨?chunk 鏁版嵁
   */
  private convertAndEmitChunk(
    chunk: TextStreamPart<any>,
    final: {
      text: string
      reasoningContent: string
      webSearchResults: AISDKWebSearchResult[]
      reasoningId: string
      providerMetadata: ProviderMetadata | undefined
    }
  ) {
    logger.silly(`AI SDK chunk type: ${chunk.type}`, chunk)
    switch (chunk.type) {
      case 'raw': {
        const agentRawMessage = chunk.rawValue as ClaudeCodeRawValue
        if (agentRawMessage.type === 'init' && agentRawMessage.session_id) {
          this.onSessionUpdate?.(agentRawMessage.session_id)
        } else if (agentRawMessage.type === 'compact' && agentRawMessage.session_id) {
          this.onSessionUpdate?.(agentRawMessage.session_id)
        }
        this.onChunk({
          type: ChunkType.RAW,
          content: agentRawMessage
        })
        break
      }
      // === 鏂囨湰鐩稿叧浜嬩欢 ===
      case 'text-start':
        // 濡傛灉鏈夋湭瀹屾垚鐨勬€濊€冨唴瀹癸紝鍏堢敓鎴?THINKING_COMPLETE
        // 杩欏鐞嗕簡鏌愪簺鎻愪緵鍟嗕笉鍙戦€?reasoning-end 浜嬩欢鐨勬儏鍐?        this.emitThinkingCompleteIfNeeded(final)
        this.onChunk({
          type: ChunkType.TEXT_START
        })
        break
      case 'text-delta': {
        this.hasTextContent = true
        const processedText = chunk.text || ''
        let finalText: string

        // Only apply link conversion if web search is enabled
        if (this.enableWebSearch) {
          const result = convertLinks(processedText, this.isFirstChunk)

          if (this.isFirstChunk) {
            this.isFirstChunk = false
          }

          // Handle buffered content
          if (result.hasBufferedContent) {
            finalText = result.text
          } else {
            finalText = result.text || processedText
          }
        } else {
          // Without web search, just use the original text
          finalText = processedText
        }

        if (this.accumulate) {
          final.text += finalText
        } else {
          final.text = finalText
        }

        // Extract thoughtSignature from providerMetadata.google and preserve it
        const newSignature = chunk.providerMetadata?.google?.thoughtSignature as string | undefined
        if (newSignature) {
          final.providerMetadata = {
            ...final.providerMetadata,
            google: {
              ...final.providerMetadata?.google,
              thoughtSignature: newSignature
            }
          }
        }

        // Only emit chunk if there's text to send
        if (finalText) {
          this.markFirstTokenIfNeeded()
          this.onChunk({
            type: ChunkType.TEXT_DELTA,
            text: this.accumulate ? final.text : finalText,
            providerMetadata: final.providerMetadata
          })
        }
        break
      }
      case 'text-end':
        this.onChunk({
          type: ChunkType.TEXT_COMPLETE,
          text: (chunk.providerMetadata?.text?.value as string) ?? final.text ?? '',
          providerMetadata: final.providerMetadata
        })
        final.text = ''
        // Clear providerMetadata for next text block
        final.providerMetadata = undefined
        break
      case 'reasoning-start':
        // if (final.reasoningId !== chunk.id) {
        final.reasoningId = chunk.id
        this.onChunk({
          type: ChunkType.THINKING_START
        })
        // }
        break
      case 'reasoning-delta':
        final.reasoningContent += chunk.text || ''
        if (chunk.text) {
          this.markFirstTokenIfNeeded()
        }
        this.onChunk({
          type: ChunkType.THINKING_DELTA,
          text: final.reasoningContent || ''
        })
        break
      case 'reasoning-end':
        this.emitThinkingCompleteIfNeeded(final)
        break

      // === 宸ュ叿璋冪敤鐩稿叧浜嬩欢锛堝師濮?AI SDK 浜嬩欢锛屽鏋滄病鏈夎涓棿浠跺鐞嗭級 ===

      case 'tool-input-start':
        this.toolCallHandler.handleToolInputStart(chunk)
        break
      case 'tool-input-delta':
        this.toolCallHandler.handleToolInputDelta(chunk)
        break
      case 'tool-input-end':
        this.toolCallHandler.handleToolInputEnd(chunk)
        break

      case 'tool-call':
        this.toolCallHandler.handleToolCall(chunk)
        break

      case 'tool-error':
        this.toolCallHandler.handleToolError(chunk)
        break

      case 'tool-result':
        this.toolCallHandler.handleToolResult(chunk)
        break

      case 'finish-step': {
        const { providerMetadata, finishReason } = chunk
        // googel web search
        if (providerMetadata?.google?.groundingMetadata) {
          this.onChunk({
            type: ChunkType.LLM_WEB_SEARCH_COMPLETE,
            llm_web_search: {
              results: providerMetadata.google?.groundingMetadata as WebSearchResults,
              source: WEB_SEARCH_SOURCE.GEMINI
            }
          })
        } else if (final.webSearchResults.length) {
          const providerName: string | undefined = Object.keys(providerMetadata || {})[0] || this.providerId
          const sourceMap: Record<string, WebSearchSource> = {
            [WEB_SEARCH_SOURCE.OPENAI]: WEB_SEARCH_SOURCE.OPENAI_RESPONSE,
            [WEB_SEARCH_SOURCE.ANTHROPIC]: WEB_SEARCH_SOURCE.ANTHROPIC,
            [WEB_SEARCH_SOURCE.OPENROUTER]: WEB_SEARCH_SOURCE.OPENROUTER,
            [WEB_SEARCH_SOURCE.GEMINI]: WEB_SEARCH_SOURCE.GEMINI,
            // [WebSearchSource.PERPLEXITY]: WebSearchSource.PERPLEXITY,
            [WEB_SEARCH_SOURCE.QWEN]: WEB_SEARCH_SOURCE.QWEN,
            [WEB_SEARCH_SOURCE.HUNYUAN]: WEB_SEARCH_SOURCE.HUNYUAN,
            [WEB_SEARCH_SOURCE.ZHIPU]: WEB_SEARCH_SOURCE.ZHIPU,
            [WEB_SEARCH_SOURCE.GROK]: WEB_SEARCH_SOURCE.GROK,
            xai: WEB_SEARCH_SOURCE.GROK,
            [WEB_SEARCH_SOURCE.WEBSEARCH]: WEB_SEARCH_SOURCE.WEBSEARCH
          }
          const source = (providerName && sourceMap[providerName]) || WEB_SEARCH_SOURCE.AISDK

          this.onChunk({
            type: ChunkType.LLM_WEB_SEARCH_COMPLETE,
            llm_web_search: {
              results: final.webSearchResults,
              source
            }
          })
        }
        if (finishReason === 'tool-calls') {
          this.onChunk({ type: ChunkType.LLM_RESPONSE_CREATED })
        }

        final.webSearchResults = []
        // final.reasoningId = ''
        break
      }

      case 'finish': {
        // Check if session was cleared (e.g., /clear command) and no text was output
        const sessionCleared = this.getSessionWasCleared?.() ?? false
        if (sessionCleared && !this.hasTextContent) {
          // Inject a "context cleared" message for the user
          const clearMessage = '鉁?Context cleared. Starting fresh conversation.'
          this.onChunk({
            type: ChunkType.TEXT_START
          })
          this.onChunk({
            type: ChunkType.TEXT_DELTA,
            text: clearMessage
          })
          this.onChunk({
            type: ChunkType.TEXT_COMPLETE,
            text: clearMessage
          })
          final.text = clearMessage
        }

        const usage = {
          completion_tokens: chunk.totalUsage?.outputTokens || 0,
          prompt_tokens: chunk.totalUsage?.inputTokens || 0,
          total_tokens: chunk.totalUsage?.totalTokens || 0
        }
        const metrics = this.buildMetrics(chunk.totalUsage)
        const baseResponse = {
          text: final.text || '',
          reasoning_content: final.reasoningContent || ''
        }

        this.onChunk({
          type: ChunkType.BLOCK_COMPLETE,
          response: {
            ...baseResponse,
            usage: { ...usage },
            metrics: metrics ? { ...metrics } : undefined
          }
        })
        this.onChunk({
          type: ChunkType.LLM_RESPONSE_COMPLETE,
          response: {
            ...baseResponse,
            usage: { ...usage },
            metrics: metrics ? { ...metrics } : undefined
          }
        })
        this.resetTimingState()
        break
      }

      // === 婧愬拰鏂囦欢鐩稿叧浜嬩欢 ===
      case 'source':
        if (chunk.sourceType === 'url') {
          // oxlint-disable-next-line @typescript-eslint/no-unused-vars
          const { sourceType: _, ...rest } = chunk
          final.webSearchResults.push(rest)
        }
        break
      case 'file':
        // 鏂囦欢鐩稿叧浜嬩欢锛屽彲鑳芥槸鍥剧墖鐢熸垚
        this.onChunk({
          type: ChunkType.IMAGE_COMPLETE,
          image: {
            type: 'base64',
            images: [`data:${chunk.file.mediaType};base64,${chunk.file.base64}`]
          }
        })
        break
      case 'abort':
        this.onChunk({
          type: ChunkType.ERROR,
          error: new DOMException('Request was aborted', 'AbortError')
        })
        break
      case 'error':
        this.onChunk({
          type: ChunkType.ERROR,
          error: AISDKError.isInstance(chunk.error)
            ? chunk.error
            : new ProviderSpecificError({
                message: formatErrorMessage(chunk.error),
                provider: 'unknown',
                cause: chunk.error
              })
        })
        break

      default:
    }
  }

  private buildMetrics(totalUsage?: {
    inputTokens?: number | null
    outputTokens?: number | null
    totalTokens?: number | null
  }) {
    if (!totalUsage) {
      return undefined
    }

    const completionTokens = totalUsage.outputTokens ?? 0
    const now = Date.now()
    const start = this.responseStartTimestamp ?? now
    const firstToken = this.firstTokenTimestamp
    const timeFirstToken = Math.max(firstToken != null ? firstToken - start : 0, 0)
    const baseForCompletion = firstToken ?? start
    let timeCompletion = Math.max(now - baseForCompletion, 0)

    if (timeCompletion === 0 && completionTokens > 0) {
      timeCompletion = 1
    }

    return {
      completion_tokens: completionTokens,
      time_first_token_millsec: timeFirstToken,
      time_completion_millsec: timeCompletion
    }
  }
}

export default AiSdkToChunkAdapter

