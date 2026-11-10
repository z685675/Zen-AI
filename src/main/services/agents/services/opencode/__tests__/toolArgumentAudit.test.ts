import { describe, expect, it } from 'vitest'

import { ToolArgumentAuditScope } from '../toolArgumentAudit'
import { OpenCodeUsageObserver } from '../usageObservation'

function setup() {
  const events: Record<string, any>[] = []
  const scope = new ToolArgumentAuditScope((_event, details) => events.push(details))
  const wire = scope.wire('transport-1')
  wire.request(
    Buffer.from(
      JSON.stringify({
        tools: [
          {
            type: 'function',
            function: {
              name: 'create',
              parameters: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' } } }
            }
          }
        ]
      })
    )
  )
  wire.requestFinished(true)
  wire.headers('server-request-1')
  const calls = () => events.filter((item) => item.phase === 'provider-wire')
  return { scope, wire, events, calls }
}
describe('private tool argument boundary audit', () => {
  it('marks out-of-order identity and reused stream indices as unconfirmed rather than proving argument loss', () => {
    const orphan = setup()
    orphan.wire.frame({
      type: 'response.function_call_arguments.delta',
      item_id: 'late-item',
      delta: '{"file_path":"PRIVATE"}'
    })
    orphan.wire.frame({
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'late-item', type: 'function_call', call_id: 'a', name: 'create', arguments: '{}' }
    })
    orphan.wire.finish(true)
    expect(orphan.calls().every((call) => !call.argumentComplete)).toBe(true)
    const reused = setup()
    for (const id of ['a', 'b'])
      reused.wire.frame({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id, function: { name: 'create', arguments: '{}' } }] },
            finish_reason: 'tool_calls'
          }
        ]
      })
    reused.wire.finish(true)
    expect(reused.calls()[0].argumentComplete).toBe(false)
  })
  it('assembles interleaved Chinese arguments across UTF-8 transport chunks and compares canonical inputs', () => {
    const { scope, wire, calls, events } = setup()
    const frames = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'create', arguments: '{"file_path":"秘' } },
                { index: 1, id: 'b', function: { name: 'create', arguments: '{"file_path":"' } }
              ]
            }
          }
        ]
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: '密乙.txt"}' } },
                { index: 0, id: '', function: { name: '', arguments: '密甲.txt"}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      }
    ]
      .map((item) => `data: ${JSON.stringify(item)}\r\n\r\n`)
      .join('')
    const observer = new OpenCodeUsageObserver('text/event-stream', (frame) => wire.frame(frame))
    for (const byte of Buffer.from(frames)) observer.push(Uint8Array.of(byte))
    wire.finish(observer.finish(true).complete)
    scope.native('session:a', 'create', { file_path: '秘密甲.txt' })
    scope.execution('create', { file_path: '秘密甲.txt' }, 'rpc-5')
    expect(calls()).toHaveLength(2)
    expect(calls()[0]).toMatchObject({
      nativeToolCallId: 'a',
      argumentState: 'object',
      missingRequiredKeys: 0,
      argumentComplete: true,
      argumentFragments: 2
    })
    expect(calls()[1].argumentFingerprint).not.toBe(calls()[0].argumentFingerprint)
    expect(events.find((item) => item.phase === 'native-decoded')?.argumentFingerprint).toBe(
      calls()[0].argumentFingerprint
    )
    expect(events.find((item) => item.phase === 'mcp-execution')?.argumentFingerprint).toBe(
      calls()[0].argumentFingerprint
    )
    expect(JSON.stringify(events)).not.toContain('秘密')
  })
  it('distinguishes missing required arguments from a valid zero-argument tool', () => {
    const { wire, calls } = setup()
    wire.request(
      Buffer.from(
        JSON.stringify({
          tools: [
            { name: 'create', parameters: { type: 'object', required: ['file_path'] } },
            { name: 'clock', parameters: { type: 'object' } }
          ]
        })
      )
    )
    wire.requestFinished(true)
    wire.frame({
      choices: [
        {
          message: {
            tool_calls: [
              { id: 'a', function: { name: 'create', arguments: '{}' } },
              { id: 'b', function: { name: 'clock', arguments: '{}' } }
            ]
          }
        }
      ]
    })
    wire.finish(true)
    expect(calls()[0]).toMatchObject({ argumentState: 'empty-object', requiredKeys: 1, missingRequiredKeys: 1 })
    expect(calls()[1]).toMatchObject({ argumentState: 'empty-object', requiredKeys: 0, missingRequiredKeys: 0 })
  })
  it('observes final-only snapshots and detects a protocol conflict without replacing deltas', () => {
    const { wire, calls } = setup()
    wire.frame({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'create', arguments: '{}' } }] } }]
    })
    wire.frame({
      choices: [
        {
          message: { tool_calls: [{ id: 'a', function: { name: 'create', arguments: '{"file_path":"PRIVATE"}' } }] },
          finish_reason: 'tool_calls'
        }
      ]
    })
    wire.finish(true)
    expect(calls()[0]).toMatchObject({ argumentState: 'empty-object', snapshotMatches: false })
    const next = setup()
    next.wire.frame({
      choices: [
        { message: { tool_calls: [{ id: 'x', function: { name: 'create', arguments: '{"file_path":"PRIVATE"}' } }] } }
      ]
    })
    next.wire.finish(true)
    expect(next.calls()[0]).toMatchObject({ argumentState: 'object', argumentFragments: 0, argumentComplete: true })
  })
  it('correlates Responses item IDs with native call IDs and does not mix concurrent output', () => {
    const { wire, calls } = setup()
    for (let index = 0; index < 2; index++)
      wire.frame({
        type: 'response.output_item.added',
        output_index: index,
        item: { id: `item${index}`, type: 'function_call', call_id: `call${index}`, name: 'create', arguments: '' }
      })
    wire.frame({ type: 'response.function_call_arguments.delta', item_id: 'item1', delta: '{"file_path":"B"}' })
    wire.frame({ type: 'response.function_call_arguments.delta', item_id: 'item0', delta: '{}' })
    wire.frame({ type: 'response.function_call_arguments.done', item_id: 'item0', arguments: '{}' })
    wire.frame({
      type: 'response.output_item.done',
      output_index: 1,
      item: { id: 'item1', type: 'function_call', call_id: 'call1', name: 'create', arguments: '{"file_path":"B"}' }
    })
    wire.finish(true)
    expect(calls()).toHaveLength(2)
    expect(calls()[0]).toMatchObject({
      nativeToolCallId: 'call0',
      argumentState: 'empty-object',
      missingRequiredKeys: 1
    })
    expect(calls()[1]).toMatchObject({ nativeToolCallId: 'call1', argumentState: 'object', missingRequiredKeys: 0 })
  })
  it('ignores Anthropic placeholder inputs when real input JSON deltas arrive', () => {
    const { wire, calls } = setup()
    wire.frame({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'anthropic-a', name: 'create', input: {} }
    })
    wire.frame({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"file_path":"PRIVATE"}' }
    })
    wire.frame({ type: 'content_block_stop', index: 1 })
    wire.finish(true)
    expect(calls()[0]).toMatchObject({ argumentState: 'object', argumentComplete: true })
    expect(calls()[0].snapshotMatches).toBeUndefined()
  })
  it('does not diagnose empty arguments when an SSE frame is truncated, malformed or oversized', () => {
    for (const suffix of ['data: {"choices":', 'data: BROKEN\n\n', 'data: ' + 'x'.repeat(300_000) + '\n\n']) {
      const { wire, calls } = setup()
      const observer = new OpenCodeUsageObserver('text/event-stream', (frame) => wire.frame(frame))
      observer.push(
        Buffer.from(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"create","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
            suffix
        )
      )
      wire.finish(observer.finish(true).complete)
      expect(calls()[0].argumentComplete).toBe(false)
    }
  })
  it('bounds request/schema collection, call count and per-argument assembly', () => {
    const { wire, calls, events } = setup()
    wire.request(Buffer.alloc(2 * 1024 * 1024 + 1))
    wire.requestFinished(true)
    for (let i = 0; i < 200; i++)
      wire.frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: i, id: `call${i}`, function: { name: 'create', arguments: 'x'.repeat(i ? 1 : 300_000) } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      })
    wire.finish(true)
    expect(calls()).toHaveLength(128)
    expect(calls()[0]).toMatchObject({ argumentState: 'limited', argumentComplete: false, schemaCoverage: 'limited' })
    expect(JSON.stringify(events).length).toBeLessThan(100_000)
  })
  it('uses a fresh keyed fingerprint for every turn and never stores argument values', () => {
    const a = setup(),
      b = setup()
    const input = { file_path: 'PRIVATE_SECRET', nested: { 中文: 'PRIVATE_VALUE' } }
    expect(a.scope.describe(input).argumentFingerprint).not.toBe(b.scope.describe(input).argumentFingerprint)
    expect(a.scope.describe({ b: 1, a: 2 }).argumentFingerprint).toBe(
      a.scope.describe({ a: 2, b: 1 }).argumentFingerprint
    )
    a.scope.native('session:call', 'create', input)
    expect(JSON.stringify(a.events)).not.toContain('PRIVATE')
  })
})
