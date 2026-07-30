import { randomUUID } from 'node:crypto'

import type { FinishReason, LanguageModelUsage, ProviderMetadata, TextStreamPart } from 'ai'

type CodexUsage = {
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
}

type CodexAgentMessageItem = {
  id: string
  type: 'agent_message'
  text: string
}

type CodexReasoningItem = {
  id: string
  type: 'reasoning'
  text: string
}

type CodexCommandExecutionItem = {
  id: string
  type: 'command_execution'
  command: string
  aggregated_output: string
  exit_code?: number
  status: 'in_progress' | 'completed' | 'failed'
}

type CodexFileChangeItem = {
  id: string
  type: 'file_change'
  changes: Array<{ path: string; kind: 'add' | 'delete' | 'update' }>
  status: 'completed' | 'failed'
}

type CodexMcpToolCallItem = {
  id: string
  type: 'mcp_tool_call'
  server: string
  tool: string
  arguments: unknown
  result?: unknown
  error?: { message: string }
  status: 'in_progress' | 'completed' | 'failed'
}

type CodexWebSearchItem = {
  id: string
  type: 'web_search'
  query: string
}

type CodexTodoListItem = {
  id: string
  type: 'todo_list'
  items: Array<{ text: string; completed: boolean }>
}

type CodexErrorItem = {
  id: string
  type: 'error'
  message: string
}

export type CodexThreadItem =
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem
  | CodexTodoListItem
  | CodexErrorItem

export type CodexThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: CodexUsage }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started'; item: CodexThreadItem }
  | { type: 'item.updated'; item: CodexThreadItem }
  | { type: 'item.completed'; item: CodexThreadItem }
  | { type: 'error'; message: string }

type AgentStreamPart = TextStreamPart<Record<string, any>>

type TextLikeState = {
  emittedStart: boolean
  emittedText: string
}

type ToolState = {
  emittedCall: boolean
  toolName: string
  input: unknown
}

const emptyUsage: LanguageModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    noCacheTokens: 0
  },
  outputTokenDetails: {
    textTokens: 0,
    reasoningTokens: 0
  }
}

const generateId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '')}`

export class CodexStreamState {
  private textByItemId = new Map<string, TextLikeState>()
  private reasoningByItemId = new Map<string, TextLikeState>()
  private toolByItemId = new Map<string, ToolState>()
  private stepActive = false
  threadId?: string

  beginStep(): boolean {
    if (this.stepActive) {
      return false
    }
    this.stepActive = true
    return true
  }

  hasActiveStep(): boolean {
    return this.stepActive
  }

  endStep(): void {
    this.stepActive = false
    this.textByItemId.clear()
    this.reasoningByItemId.clear()
    this.toolByItemId.clear()
  }

  getTextState(itemId: string): TextLikeState {
    return this.getTextLikeState(this.textByItemId, itemId)
  }

  getReasoningState(itemId: string): TextLikeState {
    return this.getTextLikeState(this.reasoningByItemId, itemId)
  }

  getToolState(itemId: string): ToolState | undefined {
    return this.toolByItemId.get(itemId)
  }

  setToolState(itemId: string, state: ToolState): void {
    this.toolByItemId.set(itemId, state)
  }

  private getTextLikeState(map: Map<string, TextLikeState>, itemId: string): TextLikeState {
    const existing = map.get(itemId)
    if (existing) {
      return existing
    }

    const next = {
      emittedStart: false,
      emittedText: ''
    }
    map.set(itemId, next)
    return next
  }
}

export function transformCodexEventToStreamParts(event: CodexThreadEvent, state: CodexStreamState): AgentStreamPart[] {
  const providerMetadata = codexProviderMetadata(event)

  switch (event.type) {
    case 'thread.started':
      state.threadId = event.thread_id
      return [
        { type: 'start' },
        {
          type: 'raw',
          rawValue: {
            type: 'codex_thread_started',
            thread_id: event.thread_id,
            raw: event
          }
        }
      ] as AgentStreamPart[]

    case 'turn.started':
      return state.beginStep()
        ? [
            {
              type: 'start-step',
              request: { body: '' },
              warnings: []
            }
          ]
        : []

    case 'turn.completed': {
      const usage = convertCodexUsage(event.usage)
      const chunks: AgentStreamPart[] = []
      if (state.hasActiveStep()) {
        chunks.push({
          type: 'finish-step',
          response: {
            id: state.threadId ?? generateId('codex_turn'),
            timestamp: new Date(),
            modelId: ''
          },
          usage,
          finishReason: 'stop',
          rawFinishReason: 'turn.completed',
          providerMetadata
        })
      }
      chunks.push({
        type: 'finish',
        totalUsage: usage,
        finishReason: 'stop',
        rawFinishReason: 'turn.completed',
        providerMetadata
      } as AgentStreamPart)
      state.endStep()
      return chunks
    }

    case 'turn.failed':
      state.endStep()
      return [toErrorPart(event.error.message, providerMetadata)]

    case 'error':
      state.endStep()
      return [toErrorPart(event.message, providerMetadata)]

    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return transformCodexItemEvent(event, state, providerMetadata)

    default:
      return []
  }
}

function transformCodexItemEvent(
  event: Extract<CodexThreadEvent, { type: 'item.started' | 'item.updated' | 'item.completed' }>,
  state: CodexStreamState,
  providerMetadata: ProviderMetadata
): AgentStreamPart[] {
  const { item } = event

  switch (item.type) {
    case 'agent_message':
      return transformTextLikeItem({
        itemId: item.id,
        text: item.text,
        completed: event.type === 'item.completed',
        state: state.getTextState(item.id),
        providerMetadata,
        startType: 'text-start',
        deltaType: 'text-delta',
        endType: 'text-end'
      })

    case 'reasoning':
      return transformTextLikeItem({
        itemId: item.id,
        text: item.text,
        completed: event.type === 'item.completed',
        state: state.getReasoningState(item.id),
        providerMetadata,
        startType: 'reasoning-start',
        deltaType: 'reasoning-delta',
        endType: 'reasoning-end'
      })

    case 'command_execution':
      return transformToolLikeItem({
        itemId: item.id,
        toolName: 'codex.command_execution',
        input: { command: item.command },
        output: item.aggregated_output,
        status: item.status,
        completed: event.type === 'item.completed',
        state,
        providerMetadata
      })

    case 'mcp_tool_call':
      return transformToolLikeItem({
        itemId: item.id,
        toolName: `mcp__${item.server}__${item.tool}`,
        input: item.arguments,
        output: item.result,
        error: item.error?.message,
        status: item.status,
        completed: event.type === 'item.completed',
        state,
        providerMetadata
      })

    case 'web_search':
      return transformToolLikeItem({
        itemId: item.id,
        toolName: 'codex.web_search',
        input: { query: item.query },
        output: { query: item.query },
        status: 'completed',
        completed: event.type === 'item.completed',
        state,
        providerMetadata
      })

    case 'file_change':
      return [
        {
          type: 'raw',
          rawValue: {
            type: 'codex_file_change',
            item,
            raw: event
          },
          providerMetadata
        } as AgentStreamPart
      ]

    case 'todo_list':
      return [
        {
          type: 'raw',
          rawValue: {
            type: 'codex_todo_list',
            item,
            raw: event
          },
          providerMetadata
        } as AgentStreamPart
      ]

    case 'error':
      return [
        {
          type: 'raw',
          rawValue: {
            type: 'codex_warning',
            message: item.message,
            raw: event
          },
          providerMetadata
        } as AgentStreamPart
      ]

    default:
      return []
  }
}

function transformTextLikeItem(params: {
  itemId: string
  text: string
  completed: boolean
  state: TextLikeState
  providerMetadata: ProviderMetadata
  startType: 'text-start' | 'reasoning-start'
  deltaType: 'text-delta' | 'reasoning-delta'
  endType: 'text-end' | 'reasoning-end'
}): AgentStreamPart[] {
  const chunks: AgentStreamPart[] = []

  if (!params.state.emittedStart) {
    chunks.push({
      type: params.startType,
      id: params.itemId,
      providerMetadata: params.providerMetadata
    } as AgentStreamPart)
    params.state.emittedStart = true
  }

  const delta = params.text.slice(params.state.emittedText.length)
  if (delta) {
    chunks.push({
      type: params.deltaType,
      id: params.itemId,
      text: delta,
      providerMetadata: params.providerMetadata
    } as AgentStreamPart)
    params.state.emittedText = params.text
  }

  if (params.completed) {
    chunks.push({
      type: params.endType,
      id: params.itemId,
      providerMetadata: params.providerMetadata
    } as AgentStreamPart)
  }

  return chunks
}

function transformToolLikeItem(params: {
  itemId: string
  toolName: string
  input: unknown
  output: unknown
  error?: string
  status: 'in_progress' | 'completed' | 'failed'
  completed: boolean
  state: CodexStreamState
  providerMetadata: ProviderMetadata
}): AgentStreamPart[] {
  const chunks: AgentStreamPart[] = []
  let toolState = params.state.getToolState(params.itemId)

  if (!toolState) {
    toolState = {
      emittedCall: false,
      toolName: params.toolName,
      input: params.input
    }
    params.state.setToolState(params.itemId, toolState)
  }

  if (!toolState.emittedCall) {
    chunks.push({
      type: 'tool-call',
      toolCallId: params.itemId,
      toolName: params.toolName,
      input: params.input,
      providerExecuted: true,
      providerMetadata: params.providerMetadata
    })
    toolState.emittedCall = true
  }

  if (!params.completed && params.status === 'in_progress') {
    chunks.push({
      type: 'raw',
      rawValue: {
        type: 'codex_tool_progress',
        itemId: params.itemId,
        toolName: params.toolName,
        status: params.status,
        output: params.output
      },
      providerMetadata: params.providerMetadata
    } as AgentStreamPart)
    return chunks
  }

  if (params.error || params.status === 'failed') {
    chunks.push({
      type: 'tool-error',
      toolCallId: params.itemId,
      toolName: params.toolName,
      input: toolState.input,
      error: params.error ?? params.output ?? 'Codex tool failed',
      providerExecuted: true,
      providerMetadata: params.providerMetadata
    } as AgentStreamPart)
    return chunks
  }

  if (params.completed || params.status === 'completed') {
    chunks.push({
      type: 'tool-result',
      toolCallId: params.itemId,
      toolName: params.toolName,
      input: toolState.input,
      output: params.output,
      providerExecuted: true,
      providerMetadata: params.providerMetadata
    })
  }

  return chunks
}

function convertCodexUsage(usage?: CodexUsage): LanguageModelUsage {
  if (!usage) {
    return emptyUsage
  }

  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  const reasoningTokens = usage.reasoning_output_tokens ?? 0
  const cacheReadTokens = usage.cached_input_tokens ?? 0

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokenDetails: {
      cacheReadTokens,
      cacheWriteTokens: 0,
      noCacheTokens: Math.max(inputTokens - cacheReadTokens, 0)
    },
    outputTokenDetails: {
      textTokens: Math.max(outputTokens - reasoningTokens, 0),
      reasoningTokens
    }
  }
}

function codexProviderMetadata(event: CodexThreadEvent): ProviderMetadata {
  return {
    codex: {
      type: event.type
    },
    raw: event as Record<string, any>
  }
}

function toErrorPart(message: string, providerMetadata: ProviderMetadata): AgentStreamPart {
  return {
    type: 'error',
    error: { message },
    providerMetadata
  } as AgentStreamPart
}

export function mapCodexReasoningEffort(effort?: string): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  switch (effort) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return effort
    case 'max':
      return 'xhigh'
    default:
      return undefined
  }
}

export function mapCodexApprovalPolicy(permissionMode?: string): 'never' | 'on-request' | 'on-failure' | 'untrusted' {
  return permissionMode === 'bypassPermissions' ? 'never' : 'on-request'
}

export function mapCodexFinishReason(): FinishReason {
  return 'stop'
}
