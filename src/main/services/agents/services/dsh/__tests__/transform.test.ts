import { describe, expect, it } from 'vitest'

import { DshStreamState } from '../transform'

describe('DSH native stream conversion', () => {
  it('keeps live text and reasoning distinct and closes each native block once', () => {
    const state = new DshStreamState('zen', 'native')
    const consume = (frame: Record<string, unknown>) =>
      state.consume({ method: 'assistant.stream', params: { sessionId: 'native', frame } })
    consume({ type: 'start', attemptId: 'attempt' })
    expect(consume({ type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'Think' } })).toMatchObject([
      { type: 'reasoning-start' },
      { type: 'reasoning-delta', text: 'Think' }
    ])
    expect(consume({ type: 'chunk', chunk: { type: 'text-delta', index: 1, text: 'Done' } })).toMatchObject([
      { type: 'text-start' },
      { type: 'text-delta', text: 'Done' }
    ])
    expect(consume({ type: 'end' }).map((chunk) => chunk.type)).toEqual(['reasoning-end', 'text-end'])
    expect(state.closeParts()).toEqual([])
  })

  it('preserves authoritative MCP file cards and reports native tool failures', () => {
    const state = new DshStreamState('zen', 'native')
    const event = (type: string, data: Record<string, unknown>, seq: number) =>
      state.consume({ method: 'session.event', params: { sessionId: 'native', event: { type, data, seq } } })
    expect(
      event(
        'tool/call',
        { callId: 'file', name: 'mcp__assistant__present_files', arguments: '{"file_paths":["/out/report.pdf"]}' },
        1
      )[0]
    ).toMatchObject({ type: 'tool-call', toolCallId: 'zen:file', input: { file_paths: ['/out/report.pdf'] } })
    const value = { content: [{ type: 'resource_link', uri: '/out/report.pdf', name: 'report.pdf' }] }
    state.consume({ method: 'tool.output', params: { sessionId: 'native', callId: 'file', value } })
    const result = event(
      'tool/result',
      { message: { toolCallId: 'file', content: [{ type: 'text', text: 'file ready' }] } },
      2
    )
    expect(result[0]).toMatchObject({ type: 'tool-result', output: value, providerMetadata: { raw: value } })
    expect(event('tool/result', { message: { toolCallId: 'file' } }, 2)).toEqual([])
    expect(
      event(
        'tool/result',
        { message: { toolCallId: 'failed', isError: true, content: [{ type: 'text', text: 'Denied' }] } },
        3
      )[0]
    ).toMatchObject({ type: 'tool-error', error: 'Denied' })
  })

  it('counts only committed native usage once and exposes durable terminal errors', () => {
    const state = new DshStreamState('zen', 'native')
    const event = {
      method: 'session.event',
      params: {
        sessionId: 'native',
        event: {
          type: 'assistant/message',
          seq: 2,
          data: { usage: { inputTokens: 10, outputTokens: 6, reasoningTokens: 2, cacheReadTokens: 3 } }
        }
      }
    }
    state.consume(event)
    state.consume(event)
    expect(state.usage()).toMatchObject({
      inputTokens: 10,
      outputTokens: 6,
      totalTokens: 16,
      outputTokenDetails: { textTokens: 4, reasoningTokens: 2 }
    })
    state.consume({
      method: 'session.event',
      params: {
        sessionId: 'native',
        event: {
          type: 'turn/end',
          data: { reason: { kind: 'error', error: { code: 'AUTH', message: 'Authentication failed' } } }
        }
      }
    })
    expect(state.error?.message).toBe('Authentication failed')
    expect(state.terminal).toBe('error')
  })
})
