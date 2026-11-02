import { describe, expect, it } from 'vitest'

import { ToolInputProgress } from '../toolInputProgress'
import { OpenCodeUsageObserver } from '../usageObservation'

describe('content-free tool parameter progress', () => {
  it('recognizes fragmented chat, Responses and Anthropic parameter deltas, not heartbeat or completed snapshots', () => {
    const progress = new ToolInputProgress()
    expect(
      progress.characters({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"file":' } }] } }] })
    ).toBe(8)
    expect(
      progress.characters({ type: 'response.function_call_arguments.delta', sequence_number: 3, delta: 'abc' })
    ).toBe(3)
    expect(
      progress.characters({ type: 'response.function_call_arguments.delta', sequence_number: 3, delta: 'abc' })
    ).toBe(0)
    expect(progress.characters({ type: 'response.function_call_arguments.done', arguments: 'abc' })).toBe(0)
    expect(
      progress.characters({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'abc' } })
    ).toBe(3)
    for (const body of [
      {},
      { type: 'ping' },
      { usage: { completion_tokens: 10 } },
      { choices: [{ message: { tool_calls: [{ function: { arguments: 'full snapshot' } }] } }] }
    ])
      expect(progress.characters(body)).toBe(0)
  })
  it('observes fragmented SSE without retaining parameter contents or counting malformed frames', () => {
    const progress = new ToolInputProgress()
    const counts: number[] = []
    const observer = new OpenCodeUsageObserver('text/event-stream', (body) => counts.push(progress.characters(body)))
    const body =
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"PRIVATE_ARGUMENT"}}]}}]}\r\n\r\n: heartbeat\r\n\r\ndata: invalid\r\n\r\n'
    for (const byte of new TextEncoder().encode(body)) observer.push(new Uint8Array([byte]))
    expect(counts).toEqual([16])
    expect(JSON.stringify(observer.finish(true))).not.toContain('PRIVATE_ARGUMENT')
    expect(JSON.stringify(progress)).not.toContain('PRIVATE_ARGUMENT')
  })
})
