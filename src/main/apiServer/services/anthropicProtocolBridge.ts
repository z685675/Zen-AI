import { randomUUID } from 'node:crypto'

import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { JSONValue } from '@ai-sdk/provider'
import { createXai } from '@ai-sdk/xai'
import type {
  ContentBlockParam,
  Message,
  MessageCreateParams,
  RawMessageStreamEvent,
  StopReason
} from '@anthropic-ai/sdk/resources/messages'
import { loggerService } from '@logger'
import {
  type AgentProtocolBridgeTarget,
  getAgentProtocolBridgeTarget
} from '@main/services/agents/services/runtime/protocol'
import type { Model, Provider } from '@types'
import {
  type FinishReason,
  generateText,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
  type TextStreamPart,
  tool,
  type ToolSet
} from 'ai'
import type { Response } from 'express'

const logger = loggerService.withContext('AnthropicProtocolBridge')

type BridgeRequest = {
  model: LanguageModel
  system?: string
  messages: ModelMessage[]
  tools?: ToolSet
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string }
  maxOutputTokens: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  providerOptions?: Record<string, Record<string, JSONValue>>
  maxRetries: number
  abortSignal?: AbortSignal
}

export type BridgeReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

type EffortAwareAnthropicRequest = MessageCreateParams & {
  effort?: unknown
  output_config?: { effort?: unknown }
}

type BridgeStreamOptions = {
  messageId?: string
  modelId: string
}

const ZEN_TOOL_REQUIRED_MARKER = '<zen-ai-tool-required>'

function selectedProviderModel(provider: Provider, modelId: string): Model | undefined {
  return provider.models?.find((model) => model.id === modelId)
}

export function extractBridgeReasoningEffort(request: MessageCreateParams): BridgeReasoningEffort | undefined {
  const effortRequest = request as EffortAwareAnthropicRequest
  const effort = effortRequest.output_config?.effort ?? effortRequest.effort

  switch (effort) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return effort
    case 'minimal':
      return 'low'
    case 'max':
      return 'xhigh'
    default:
      return undefined
  }
}

export function buildBridgeReasoningProviderOptions(
  target: AgentProtocolBridgeTarget,
  providerId: string,
  request: MessageCreateParams
): Record<string, Record<string, JSONValue>> | undefined {
  const effort = extractBridgeReasoningEffort(request)
  if (!effort) return undefined

  switch (target) {
    case 'gemini':
      return {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: effort === 'xhigh' ? 'high' : effort
          }
        }
      }
    case 'xai-chat':
      return {
        xai: {
          reasoningEffort: effort === 'low' || effort === 'medium' ? 'low' : 'high'
        }
      }
    case 'openai-responses':
      return { openai: { reasoningEffort: effort } }
    case 'openai-chat':
      return { [`zen-${providerId}`]: { reasoningEffort: effort } }
  }
}

function normalizeGeminiBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (/\/v\d+(?:alpha|beta)?$/i.test(normalized)) {
    return normalized.replace(/\/v\d+(?:alpha|beta)?$/i, '/v1beta')
  }
  return normalized
}

export function createBridgeLanguageModel(
  provider: Provider,
  modelId: string,
  target: AgentProtocolBridgeTarget
): LanguageModel {
  const headers = provider.extra_headers

  switch (target) {
    case 'gemini': {
      const google = createGoogleGenerativeAI({
        apiKey: provider.apiKey,
        baseURL: normalizeGeminiBaseUrl(provider.apiHost),
        headers,
        name: `zen-${provider.id}`
      })
      return google(modelId)
    }
    case 'xai-chat': {
      const xai = createXai({ apiKey: provider.apiKey, baseURL: provider.apiHost, headers })
      return xai.chat(modelId)
    }
    case 'openai-responses': {
      const openai = createOpenAI({
        apiKey: provider.apiKey,
        baseURL: provider.apiHost,
        headers,
        name: `zen-${provider.id}`
      })
      return openai.responses(modelId)
    }
    case 'openai-chat': {
      const openaiCompatible = createOpenAICompatible({
        apiKey: provider.apiKey,
        baseURL: provider.apiHost,
        headers,
        name: `zen-${provider.id}`,
        includeUsage: true
      })
      return openaiCompatible.chatModel(modelId)
    }
  }
}

function systemText(system: MessageCreateParams['system']): string | undefined {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return undefined

  const text = system
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim()
  return text || undefined
}

function serializeUnknownToolResultPart(part: unknown): string {
  try {
    return JSON.stringify(part) ?? String(part)
  } catch {
    return String(part)
  }
}

function toolResultPartText(part: unknown): string {
  if (!part || typeof part !== 'object') return serializeUnknownToolResultPart(part)

  const value = part as {
    type?: unknown
    text?: unknown
    tool_name?: unknown
    source?: { type?: unknown; media_type?: unknown }
  }
  if (value.type === 'text' && typeof value.text === 'string') return value.text
  if (value.type === 'tool_reference' && typeof value.tool_name === 'string') {
    return `[Tool available: ${value.tool_name}]`
  }
  if (value.type === 'image' && value.source?.type === 'base64') {
    const mediaType = typeof value.source.media_type === 'string' ? value.source.media_type : 'unknown'
    return `[Image result: ${mediaType}]`
  }
  if (value.type === 'image' && value.source?.type === 'url') return '[Image result: URL]'

  const type = typeof value.type === 'string' ? value.type : 'unknown'
  return `[Tool result content (${type})]: ${serializeUnknownToolResultPart(part)}`
}

function toolResultText(block: Extract<ContentBlockParam, { type: 'tool_result' }>): string {
  if (typeof block.content === 'string') return block.content
  if (!Array.isArray(block.content)) return ''

  return block.content.map(toolResultPartText).filter(Boolean).join('\n')
}

export function convertAnthropicMessagesToModelMessages(request: MessageCreateParams): ModelMessage[] {
  const result: ModelMessage[] = []
  const toolNames = new Map<string, string>()

  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      result.push({ role: message.role, content: message.content })
      continue
    }

    if (message.role === 'assistant') {
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'reasoning'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = []

      for (const block of message.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking') {
          content.push({ type: 'reasoning', text: block.thinking })
        } else if (block.type === 'tool_use') {
          toolNames.set(block.id, block.name)
          content.push({
            type: 'tool-call',
            toolCallId: block.id,
            toolName: block.name,
            input: block.input
          })
        }
      }

      if (content.length > 0) result.push({ role: 'assistant', content })
      continue
    }

    let userParts: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; image: string | URL; mediaType?: string }
      | { type: 'file'; data: string | URL; mediaType: string; filename?: string }
    > = []
    let toolParts: Array<{
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: { type: 'text' | 'error-text'; value: string }
    }> = []

    const flushUserParts = () => {
      if (userParts.length > 0) {
        result.push({ role: 'user', content: userParts })
        userParts = []
      }
    }
    const flushToolParts = () => {
      if (toolParts.length > 0) {
        result.push({ role: 'tool', content: toolParts })
        toolParts = []
      }
    }

    for (const block of message.content) {
      if (block.type === 'tool_result') {
        flushUserParts()
        toolParts.push({
          type: 'tool-result',
          toolCallId: block.tool_use_id,
          toolName: toolNames.get(block.tool_use_id) ?? 'unknown_tool',
          output: {
            type: block.is_error ? 'error-text' : 'text',
            value: toolResultText(block)
          }
        })
        continue
      }

      flushToolParts()
      if (block.type === 'text') {
        userParts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        const source = block.source
        if (source.type === 'base64') {
          userParts.push({ type: 'image', image: source.data, mediaType: source.media_type })
        } else if (source.type === 'url') {
          userParts.push({ type: 'image', image: new URL(source.url) })
        }
      } else if (block.type === 'document') {
        const source = block.source
        if (source.type === 'base64') {
          userParts.push({
            type: 'file',
            data: source.data,
            mediaType: source.media_type,
            filename: block.title ?? undefined
          })
        } else if (source.type === 'url') {
          userParts.push({
            type: 'file',
            data: new URL(source.url),
            mediaType: 'application/pdf',
            filename: block.title ?? undefined
          })
        } else if (source.type === 'text') {
          userParts.push({ type: 'text', text: source.data })
        }
      }
    }

    flushUserParts()
    flushToolParts()
  }

  return result
}

function convertTools(request: MessageCreateParams): ToolSet | undefined {
  if (!request.tools?.length) return undefined

  const tools: ToolSet = {}
  for (const definition of request.tools) {
    if (!('name' in definition) || typeof definition.name !== 'string') continue
    const schema =
      'input_schema' in definition ? definition.input_schema : { type: 'object', additionalProperties: true }
    tools[definition.name] = tool({
      description: 'description' in definition ? definition.description : undefined,
      inputSchema: jsonSchema(schema as Record<string, unknown>)
    })
  }
  return Object.keys(tools).length > 0 ? tools : undefined
}

function latestUserText(request: MessageCreateParams): string {
  const lastMessage = request.messages[request.messages.length - 1]
  if (!lastMessage || lastMessage.role !== 'user') return ''
  if (typeof lastMessage.content === 'string') return lastMessage.content

  return lastMessage.content
    .filter((block): block is Extract<(typeof lastMessage.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

export function convertToolChoice(request: MessageCreateParams): BridgeRequest['toolChoice'] {
  // Fusion file/browser tasks must produce a real tool call. Without this
  // guard, some OpenAI-compatible Claude endpoints answer with a promise such
  // as "I will read the file" and end the turn without doing anything.
  if (request.tools?.length && latestUserText(request).includes(ZEN_TOOL_REQUIRED_MARKER)) {
    return 'required'
  }

  const choice = request.tool_choice
  if (!choice) return undefined
  switch (choice.type) {
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return { type: 'tool', toolName: choice.name }
    case 'auto':
    default:
      return 'auto'
  }
}

export function buildBridgeRequest(
  provider: Provider,
  request: MessageCreateParams,
  modelId: string,
  abortSignal?: AbortSignal
): BridgeRequest {
  const model = selectedProviderModel(provider, modelId)
  const target = getAgentProtocolBridgeTarget(provider, model)
  if (!target) {
    throw new Error(`No protocol bridge is available for provider '${provider.id}', model '${modelId}'.`)
  }

  const languageModel = createBridgeLanguageModel(provider, modelId, target)
  const providerOptions = buildBridgeReasoningProviderOptions(target, provider.id, request)

  return {
    model: languageModel,
    system: systemText(request.system),
    messages: convertAnthropicMessagesToModelMessages(request),
    tools: convertTools(request),
    toolChoice: convertToolChoice(request),
    maxOutputTokens: request.max_tokens,
    temperature: request.temperature,
    topP: request.top_p,
    stopSequences: request.stop_sequences,
    providerOptions,
    maxRetries: 1,
    abortSignal
  }
}

function toAnthropicStopReason(reason: FinishReason): StopReason {
  if (reason === 'tool-calls') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  return 'end_turn'
}

function emptyUsage(inputTokens = 0, outputTokens = 0): Message['usage'] {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null
  }
}

function usageTokens(usage: LanguageModelUsage | undefined): { input: number; output: number } {
  return { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0 }
}

export async function* translateAiSdkStreamToAnthropicEvents(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
  options: BridgeStreamOptions
): AsyncGenerator<RawMessageStreamEvent> {
  const messageId = options.messageId ?? `msg_zen_${randomUUID().replaceAll('-', '')}`
  const blocks = new Map<
    string,
    { index: number; type: 'text' | 'tool'; closed: boolean; started: boolean; hasDelta: boolean }
  >()
  let nextIndex = 0
  let finishReason: FinishReason = 'stop'
  let finalUsage: LanguageModelUsage | undefined

  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: options.modelId,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: emptyUsage()
    }
  }

  const ensureBlock = (id: string, type: 'text' | 'tool') => {
    const existing = blocks.get(id)
    if (existing) return existing
    const block = { index: nextIndex++, type, closed: false, started: false, hasDelta: false }
    blocks.set(id, block)
    return block
  }

  for await (const part of stream) {
    switch (part.type) {
      case 'text-start': {
        const block = ensureBlock(part.id, 'text')
        if (!block.started) {
          block.started = true
          yield {
            type: 'content_block_start',
            index: block.index,
            content_block: { type: 'text', text: '', citations: null }
          }
        }
        break
      }
      case 'text-delta': {
        const block = ensureBlock(part.id, 'text')
        if (!block.started) {
          block.started = true
          yield {
            type: 'content_block_start',
            index: block.index,
            content_block: { type: 'text', text: '', citations: null }
          }
        }
        yield {
          type: 'content_block_delta',
          index: block.index,
          delta: { type: 'text_delta', text: part.text }
        }
        break
      }
      case 'text-end': {
        const block = ensureBlock(part.id, 'text')
        if (!block.closed) {
          block.closed = true
          yield { type: 'content_block_stop', index: block.index }
        }
        break
      }
      case 'tool-input-start': {
        const block = ensureBlock(part.id, 'tool')
        if (!block.started) {
          block.started = true
          yield {
            type: 'content_block_start',
            index: block.index,
            content_block: { type: 'tool_use', id: part.id, name: part.toolName, input: {} }
          }
        }
        break
      }
      case 'tool-input-delta': {
        const block = ensureBlock(part.id, 'tool')
        block.hasDelta = true
        yield {
          type: 'content_block_delta',
          index: block.index,
          delta: { type: 'input_json_delta', partial_json: part.delta }
        }
        break
      }
      case 'tool-input-end': {
        ensureBlock(part.id, 'tool')
        break
      }
      case 'tool-call': {
        const existing = blocks.get(part.toolCallId)
        const block = existing ?? ensureBlock(part.toolCallId, 'tool')
        if (!block.started) {
          block.started = true
          yield {
            type: 'content_block_start',
            index: block.index,
            content_block: { type: 'tool_use', id: part.toolCallId, name: part.toolName, input: {} }
          }
        }
        if (!block.hasDelta) {
          block.hasDelta = true
          yield {
            type: 'content_block_delta',
            index: block.index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.input ?? {}) }
          }
        }
        if (!block.closed) {
          block.closed = true
          yield { type: 'content_block_stop', index: block.index }
        }
        break
      }
      case 'finish':
        finishReason = part.finishReason
        finalUsage = part.totalUsage
        break
      case 'error':
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      case 'abort':
        throw new DOMException(typeof part.reason === 'string' ? part.reason : 'Request aborted', 'AbortError')
    }
  }

  for (const block of blocks.values()) {
    if (block.started && !block.closed) {
      block.closed = true
      yield { type: 'content_block_stop', index: block.index }
    }
  }

  const tokens = usageTokens(finalUsage)
  yield {
    type: 'message_delta',
    delta: { stop_reason: toAnthropicStopReason(finishReason), stop_sequence: null },
    usage: {
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null
    }
  }
  yield { type: 'message_stop' }
}

function buildNonStreamingMessage(modelId: string, result: Awaited<ReturnType<typeof generateText>>): Message {
  const content: Message['content'] = []
  if (result.text) content.push({ type: 'text', text: result.text, citations: null })
  for (const call of result.toolCalls) {
    content.push({ type: 'tool_use', id: call.toolCallId, name: call.toolName, input: call.input })
  }
  const tokens = usageTokens(result.usage)
  return {
    id: `msg_zen_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model: modelId,
    content,
    stop_reason: toAnthropicStopReason(result.finishReason),
    stop_sequence: null,
    usage: emptyUsage(tokens.input, tokens.output)
  }
}

function writeSse(response: Response, event: RawMessageStreamEvent): void {
  if (response.writableEnded || response.destroyed) return
  response.write(`event: ${event.type}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
  ;(response as Response & { flush?: () => void }).flush?.()
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

export class AnthropicProtocolBridge {
  async handle(
    provider: Provider,
    request: MessageCreateParams,
    modelId: string,
    response: Response,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const model = selectedProviderModel(provider, modelId)
    const target = getAgentProtocolBridgeTarget(provider, model)
    if (!target) {
      throw new Error(`No protocol bridge is available for provider '${provider.id}', model '${modelId}'.`)
    }

    logger.info('Bridging Anthropic Messages request', {
      providerId: provider.id,
      providerType: provider.type,
      modelId,
      target,
      stream: !!request.stream,
      messageCount: request.messages.length,
      toolCount: request.tools?.length ?? 0,
      toolChoice: request.tool_choice?.type ?? 'auto'
    })

    const bridgeRequest = buildBridgeRequest(provider, request, modelId, abortSignal)
    logger.debug('Prepared protocol bridge request', {
      modelId,
      toolCount: Object.keys(bridgeRequest.tools ?? {}).length,
      toolChoice: bridgeRequest.toolChoice ?? 'auto'
    })
    if (!request.stream) {
      const result = await generateText(bridgeRequest)
      response.json(buildNonStreamingMessage(modelId, result))
      return
    }

    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders()

    try {
      const result = streamText(bridgeRequest)
      for await (const event of translateAiSdkStreamToAnthropicEvents(result.fullStream, { modelId })) {
        writeSse(response, event)
      }
    } catch (error) {
      logger.error('Protocol bridge stream failed', {
        providerId: provider.id,
        modelId,
        target,
        error: errorMessage(error)
      })
      if (!response.writableEnded && !response.destroyed) {
        response.write('event: error\n')
        response.write(
          `data: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: errorMessage(error) } })}\n\n`
        )
      }
    } finally {
      if (!response.writableEnded) response.end()
    }
  }
}

export const anthropicProtocolBridge = new AnthropicProtocolBridge()
