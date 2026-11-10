import type { LanguageModelUsage, TextStreamPart } from 'ai'

import type { DshEvent } from '../../../dshPreview/runtime'

type Part = TextStreamPart<Record<string, any>>

export class DshStreamState {
  private blocks = new Map<string, { kind: 'text' | 'reasoning'; text: string; ended: boolean }>()
  private attempt = ''
  private calls = new Map<string, { name: string; input: unknown }>()
  private results = new Set<string>()
  private outputs = new Map<string, unknown>()
  private usageEvents = new Set<number>()
  private counters = { input: 0, output: 0, read: 0, write: 0, reasoning: 0 }
  error?: Error
  terminal?: string

  constructor(
    readonly zenSessionId: string,
    readonly nativeSessionId: string
  ) {}

  toolInput(id: string): Record<string, unknown> {
    const value = this.calls.get(id)?.input
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  }

  consume(event: DshEvent): Part[] {
    if (event.params.sessionId !== this.nativeSessionId) return []
    const chunks: Part[] = []
    if (event.method === 'tool.output') {
      if (event.params.value !== undefined) this.outputs.set(event.params.callId, event.params.value)
      return []
    }
    if (event.method === 'assistant.stream') {
      const frame = event.params.frame
      if (frame.type === 'start') {
        this.attempt = String(frame.attemptId)
        return []
      }
      if (frame.type === 'end') return this.closeParts()
      if (frame.type !== 'chunk') return []
      const chunk = frame.chunk
      const id = `${this.zenSessionId}:${this.attempt}:${chunk.index}`
      const kind =
        chunk.type === 'reasoning-delta' || chunk.blockType === 'reasoning' || chunk.block?.type === 'reasoning'
          ? 'reasoning'
          : 'text'
      if (
        (chunk.type === 'block-start' && ['text', 'reasoning'].includes(chunk.blockType)) ||
        ['text-delta', 'reasoning-delta'].includes(chunk.type)
      ) {
        if (!this.blocks.has(id)) {
          this.blocks.set(id, { kind, text: '', ended: false })
          chunks.push({ type: `${kind}-start`, id } as Part)
        }
      }
      const block = this.blocks.get(id)
      if (block && ['text-delta', 'reasoning-delta'].includes(chunk.type)) {
        block.text += chunk.text
        chunks.push({ type: `${block.kind}-delta`, id, text: chunk.text } as Part)
      }
      if (block && chunk.type === 'block-end' && !block.ended) {
        const completeText = chunk.block?.text
        if (
          typeof completeText === 'string' &&
          completeText.startsWith(block.text) &&
          completeText.length > block.text.length
        ) {
          chunks.push({ type: `${block.kind}-delta`, id, text: completeText.slice(block.text.length) } as Part)
          block.text = completeText
        }
        block.ended = true
        chunks.push({ type: `${block.kind}-end`, id, providerMetadata: { text: { value: block.text } } } as Part)
      }
    }
    if (event.method !== 'session.event') return chunks
    const native = event.params.event
    const data = native.data
    const metadata = { dsh: { sessionId: this.nativeSessionId, seq: native.seq } }
    if (native.type === 'user/message' && data.source?.kind === 'user')
      chunks.push({
        type: 'raw',
        rawValue: { type: 'dsh_turn', user_message_id: data.id, session_id: this.nativeSessionId }
      })
    if (native.type === 'tool/call') {
      if (this.calls.has(data.callId)) return chunks
      let input: unknown = data.arguments
      try {
        input = JSON.parse(data.arguments)
      } catch {
        /* Show malformed native input as received. */
      }
      this.calls.set(data.callId, { name: data.name, input })
      chunks.push({
        type: 'tool-call',
        toolCallId: `${this.zenSessionId}:${data.callId}`,
        toolName: data.name,
        input,
        providerMetadata: metadata
      })
    }
    if (native.type === 'tool/result') {
      const id = data.message.toolCallId
      if (this.results.has(id)) return chunks
      this.results.add(id)
      const call = this.calls.get(id)
      const output = this.outputs.get(id) ?? { content: data.message.content }
      this.outputs.delete(id)
      if (data.message.isError)
        chunks.push({
          type: 'tool-error',
          toolCallId: `${this.zenSessionId}:${id}`,
          toolName: call?.name || 'tool',
          input: call?.input,
          error: data.error?.reason || data.message.content?.map((block: any) => block.text || '').join('\n'),
          providerMetadata: metadata
        })
      else
        chunks.push({
          type: 'tool-result',
          toolCallId: `${this.zenSessionId}:${id}`,
          toolName: call?.name || 'tool',
          input: call?.input,
          output,
          providerMetadata: { ...metadata, raw: output as any }
        })
    }
    if (native.type === 'assistant/message' && data.usage && !this.usageEvents.has(native.seq)) {
      this.usageEvents.add(native.seq)
      this.counters.input += data.usage.inputTokens || 0
      this.counters.output += data.usage.outputTokens || 0
      this.counters.read += data.usage.cacheReadTokens || 0
      this.counters.write += data.usage.cacheWriteTokens || 0
      this.counters.reasoning += data.usage.reasoningTokens || 0
    }
    if (native.type === 'turn/end') {
      this.terminal = data.reason.kind
      if (data.reason.kind === 'error')
        this.error = Object.assign(new Error(data.reason.error.message), { code: data.reason.error.code })
    }
    return chunks
  }

  closeParts(): Part[] {
    const chunks: Part[] = []
    for (const [id, block] of this.blocks) {
      if (block.ended) continue
      block.ended = true
      chunks.push({ type: `${block.kind}-end`, id, providerMetadata: { text: { value: block.text } } } as Part)
    }
    return chunks
  }

  usage(): LanguageModelUsage {
    const { input, output, read, write, reasoning } = this.counters
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      inputTokenDetails: {
        noCacheTokens: Math.max(0, input - read - write),
        cacheReadTokens: read,
        cacheWriteTokens: write
      },
      outputTokenDetails: { textTokens: Math.max(0, output - reasoning), reasoningTokens: reasoning }
    }
  }
}
