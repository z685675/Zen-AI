import type { LanguageModelUsage, TextStreamPart } from 'ai'

import type { OpenCodeEvent } from './client'

export type NativeMessage = {
  id: string
  role: string
  summary?: boolean
  time?: { completed?: number }
  error?: { name?: string; data?: { message?: string; statusCode?: number } }
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}
type Part = TextStreamPart<Record<string, any>>
type NativePart = {
  id: string
  messageID: string
  type: string
  text?: string
  time?: { end?: number }
  [key: string]: any
}

/** Native full snapshots and deltas share one deduplication state. */
export class OpenCodeStreamState {
  readonly messages = new Map<string, NativeMessage>()
  private readonly parts = new Map<string, NativePart>()
  private readonly opened = new Set<string>()
  private readonly ended = new Set<string>()
  private readonly calls = new Set<string>()
  private readonly results = new Set<string>()
  private readonly emittedText = new Map<string, string>()
  hasVisibleOutput = false

  constructor(
    readonly sessionId: string,
    readonly zenSessionId: string,
    readonly previousMessages: Set<string>
  ) {}

  consume(event: OpenCodeEvent): Part[] {
    const props = event.properties
    if (event.type === 'message.updated') {
      const info = props.info as NativeMessage
      if (info?.role === 'assistant' && !this.previousMessages.has(info.id)) this.messages.set(info.id, info)
      return []
    }
    if (event.type === 'message.part.updated') {
      const part = props.part as NativePart
      if (!this.messages.has(part.messageID)) return []
      this.parts.set(part.id, part)
      return this.render(part)
    }
    if (event.type === 'message.part.delta' && props.field === 'text') {
      const part = this.parts.get(props.partID)
      if (!part || !this.messages.has(part.messageID)) return []
      part.text = (part.text || '') + String(props.delta || '')
      return this.render(part)
    }
    return []
  }

  private render(part: NativePart): Part[] {
    if (this.messages.get(part.messageID)?.summary || part.ignored || this.ended.has(part.id)) return []
    const metadata = { opencode: { session_id: this.sessionId, message_id: part.messageID } }
    const chunks: Part[] = []
    if (part.type === 'text' || part.type === 'reasoning') {
      const kind = part.type === 'text' ? 'text' : 'reasoning'
      if (!this.opened.has(part.id)) {
        this.opened.add(part.id)
        chunks.push({ type: `${kind}-start`, id: part.id, providerMetadata: metadata } as Part)
      }
      const text = part.text || ''
      const previous = this.emittedText.get(part.id) || ''
      if (text !== previous) {
        chunks.push({
          type: `${kind}-delta`,
          id: part.id,
          text: kind === 'text' ? text : text.slice(previous.length),
          providerMetadata: metadata
        } as Part)
        this.emittedText.set(part.id, text)
        if (kind === 'text' && text.trim()) this.hasVisibleOutput = true
      }
      if (part.time?.end) {
        this.ended.add(part.id)
        chunks.push({
          type: `${kind}-end`,
          id: part.id,
          providerMetadata: { ...metadata, text: { value: text } }
        } as Part)
      }
    } else if (part.type === 'tool') {
      const toolCallId = `${this.zenSessionId}:${part.callID}`
      const state = part.state
      if (!state || state.status === 'pending') return []
      if (!this.calls.has(part.id)) {
        this.calls.add(part.id)
        this.hasVisibleOutput = true
        chunks.push({
          type: 'tool-call',
          toolCallId,
          toolName: part.tool,
          input: state.input,
          providerMetadata: metadata
        })
      }
      if (['completed', 'error'].includes(state.status) && !this.results.has(part.id)) {
        this.results.add(part.id)
        // OpenCode retains the original MCP content in tool metadata. Preserve
        // it so Zen's file cards/images do not become plain console strings.
        const output = state.metadata?.content ? { content: state.metadata.content } : state.output
        chunks.push(
          state.status === 'error'
            ? {
                type: 'tool-error',
                toolCallId,
                toolName: part.tool,
                input: state.input,
                error: state.error,
                providerMetadata: metadata
              }
            : {
                type: 'tool-result',
                toolCallId,
                toolName: part.tool,
                input: state.input,
                output,
                providerMetadata: { ...metadata, raw: output }
              }
        )
      }
    }
    return chunks
  }

  closeParts(): Part[] {
    const chunks: Part[] = []
    for (const part of this.parts.values()) {
      if (!this.opened.has(part.id) || this.ended.has(part.id)) continue
      this.ended.add(part.id)
      chunks.push({
        type: part.type === 'text' ? 'text-end' : 'reasoning-end',
        id: part.id,
        providerMetadata: { text: { value: part.text || '' } }
      })
    }
    return chunks
  }

  usage(): LanguageModelUsage {
    let input = 0,
      output = 0,
      reasoning = 0,
      read = 0,
      write = 0
    for (const info of this.messages.values()) {
      // A native message may contain multiple model steps. Its top-level tokens
      // hold only the latest step; part IDs deduplicate updates/reconciliation.
      const steps = [...this.parts.values()].filter(
        (part) => part.messageID === info.id && part.type === 'step-finish' && part.tokens
      )
      const counters = steps.length
        ? steps.map((part) => part.tokens as NonNullable<NativeMessage['tokens']>)
        : info.tokens
          ? [info.tokens]
          : []
      for (const tokens of counters) {
        input += tokens.input || 0
        // OpenCode stores visible output separately from reasoning tokens.
        output += (tokens.output || 0) + (tokens.reasoning || 0)
        reasoning += tokens.reasoning || 0
        read += tokens.cache?.read || 0
        write += tokens.cache?.write || 0
      }
    }
    return {
      inputTokens: input + read + write,
      outputTokens: output,
      totalTokens: input + read + write + output,
      inputTokenDetails: { noCacheTokens: input, cacheReadTokens: read, cacheWriteTokens: write },
      outputTokenDetails: { textTokens: Math.max(0, output - reasoning), reasoningTokens: reasoning }
    }
  }
}
