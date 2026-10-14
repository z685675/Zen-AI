import { createAssistantToolFailure, readAssistantToolFailure } from '@shared/agents/toolFailure'
import { describe, expect, it } from 'vitest'

import { OpenCodeStreamState } from '../transform'

const message = (info: Record<string, unknown>) => ({
  type: 'message.updated',
  properties: { info: { id: 'reply', role: 'assistant', ...info } }
})
const part = (value: Record<string, unknown>) => ({
  type: 'message.part.updated',
  properties: { part: { id: 'part', messageID: 'reply', ...value } }
})

describe('OpenCode event translation', () => {
  it('preserves product failure envelopes through native MCP tool errors without replay', () => {
    const state = new OpenCodeStreamState('native', 'zen', new Set())
    state.consume(message({}))
    const failure = createAssistantToolFailure('create_file', 'Office quality validation failed')
    const value = {
      type: 'tool',
      callID: 'failed-tool',
      tool: 'mcp__assistant__create_file',
      state: {
        status: 'error',
        input: { file_path: 'test.xlsx' },
        error: JSON.stringify({ status: 'failed', failure })
      }
    }
    const chunks = state.consume(part(value))
    const error = chunks.find((chunk) => chunk.type === 'tool-error')
    expect(error?.type === 'tool-error' ? readAssistantToolFailure(error.error) : undefined).toEqual(failure)
    expect(state.consume(part(value))).toEqual([])
  })
  it('deduplicates full snapshots/deltas and preserves cumulative Zen text', () => {
    const state = new OpenCodeStreamState('native', 'zen', new Set())
    state.consume(message({}))
    expect(state.consume(part({ type: 'text', text: '你' })).map((chunk) => chunk.type)).toEqual([
      'text-start',
      'text-delta'
    ])
    expect(
      state.consume({ type: 'message.part.delta', properties: { partID: 'part', field: 'text', delta: '好' } })
    ).toMatchObject([{ type: 'text-delta', text: '你好' }])
    expect(state.consume(part({ type: 'text', text: '你好' }))).toEqual([])
    expect(state.consume(part({ type: 'text', text: '你好', time: { end: 1 } }))).toMatchObject([
      { type: 'text-end', providerMetadata: { text: { value: '你好' } } }
    ])
    expect(state.consume(part({ type: 'text', text: '你好', time: { end: 1 } }))).toEqual([])
  })
  it('does not expose previous history or native compaction summaries as new answers', () => {
    const state = new OpenCodeStreamState('native', 'zen', new Set(['previous']))
    state.consume(message({ id: 'previous' }))
    expect(state.consume(part({ messageID: 'previous', type: 'text', text: 'old' }))).toEqual([])
    state.consume(message({ summary: true }))
    expect(state.consume(part({ type: 'text', text: 'internal summary' }))).toEqual([])
    expect(state.hasVisibleOutput).toBe(false)
  })
  it('namespaces tool calls, preserves MCP content and emits each result once', () => {
    const state = new OpenCodeStreamState('native', 'zen', new Set())
    state.consume(message({}))
    const value = {
      type: 'tool',
      callID: 'tool1',
      tool: 'mcp__assistant__create_file',
      state: {
        status: 'completed',
        input: { filename: 'report.xlsx' },
        output: 'console text',
        metadata: { content: [{ type: 'text', text: '{"path":"report.xlsx"}' }] }
      }
    }
    const chunks = state.consume(part(value))
    expect(chunks).toMatchObject([
      { type: 'tool-call', toolCallId: 'zen:tool1' },
      { type: 'tool-result', output: { content: [{ type: 'text' }] } }
    ])
    expect(state.consume(part(value))).toEqual([])
  })
  it('adds latest usage once per native message, including cache reads', () => {
    const state = new OpenCodeStreamState('native', 'zen', new Set())
    const info = { tokens: { input: 20, output: 10, reasoning: 3, cache: { read: 80, write: 5 } } }
    state.consume(message(info))
    state.consume(message(info))
    expect(state.usage()).toMatchObject({
      inputTokens: 105,
      outputTokens: 13,
      totalTokens: 118,
      inputTokenDetails: { cacheReadTokens: 80 },
      outputTokenDetails: { textTokens: 10, reasoningTokens: 3 }
    })
  })
  it('sums distinct native step-finish records, not the last-step message counter or duplicate snapshots', () => {
    const state = new OpenCodeStreamState('native', 'zen', new Set())
    const first = { input: 20, output: 10, reasoning: 3, cache: { read: 80, write: 5 } }
    const last = { input: 30, output: 20, reasoning: 7, cache: { read: 90, write: 0 } }
    state.consume(message({ tokens: last }))
    state.consume(part({ id: 'step1', type: 'step-finish', tokens: first }))
    state.consume(part({ id: 'step1', type: 'step-finish', tokens: first }))
    state.consume(part({ id: 'step2', type: 'step-finish', tokens: last }))
    expect(state.usage()).toMatchObject({
      inputTokens: 225,
      outputTokens: 40,
      totalTokens: 265,
      inputTokenDetails: { cacheReadTokens: 170, cacheWriteTokens: 5 },
      outputTokenDetails: { reasoningTokens: 10, textTokens: 30 }
    })
  })
})
