import { describe, expect, it } from 'vitest'

import { QualityResponseParser } from '../response-parser'

const content = (text = '合成回答') => JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })
const stop = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
const event = (data: string) => `data: ${data}\n\n`

function parser(stream = true, mime: string | null = 'text/event-stream') {
  const values: unknown[] = []
  const value = new QualityResponseParser(stream, mime, (json) => {
    values.push(json)
    if (json.error || json.choices?.some((choice: any) => choice.finish_reason === 'error'))
      throw new Error('upstream error')
  })
  const push = (text: string) => value.push(Buffer.from(text))
  return { value, push, values }
}

describe('sanitized quality response structure and SSE framing', () => {
  it.each(['\n', '\r\n', '\r'])('frames multi-line data, comments and UTF8 across individual bytes (%j)', (newline) => {
    const test = parser()
    const text = `\uFEFF: keepalive${newline}event: anything-private${newline}data: {"choices":${newline}data: [{"delta":{"content":"你好"},"finish_reason":null}]}${newline}${newline}data: ${stop}${newline}${newline}data: [DONE]${newline}${newline}`
    const bytes = Buffer.from(text)
    for (const byte of bytes) test.value.push(new Uint8Array([byte]))
    test.value.finish()
    expect(test.values).toHaveLength(2)
    expect(test.value.evidence).toMatchObject({
      outcome: 'complete',
      framing: 'sse',
      commentLines: 1,
      otherLines: 1,
      bytes: bytes.length,
      chunks: bytes.length,
      dataEvents: 3,
      jsonEvents: 2,
      sawDone: true,
      reachedEof: true,
      hasText: true,
      finishReasons: ['stop']
    })
    expect(JSON.stringify(test.value.evidence)).not.toContain('anything-private')
  })

  it.each([
    event(content()) + event(stop),
    event(content()) + 'data: [DONE]',
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' }, finish_reason: 'stop' }] })}`
  ])('accepts either a real finish reason or DONE with output, including a final event without blank line', (body) => {
    const test = parser()
    test.push(body)
    test.value.finish()
    expect(test.value.evidence.outcome).toBe('complete')
  })

  it('accepts tool output without visible text and records no tool arguments', () => {
    const test = parser()
    test.push(
      event(
        JSON.stringify({
          choices: [
            { delta: { tool_calls: [{ function: { arguments: 'private-args' } }] }, finish_reason: 'tool_calls' }
          ]
        })
      )
    )
    test.value.finish()
    expect(test.value.evidence).toMatchObject({ hasText: false, hasToolCalls: true, outcome: 'complete' })
    expect(JSON.stringify(test.value.evidence)).not.toContain('private-args')
  })

  it.each([
    ['', 'empty-body'],
    [event('[DONE]'), 'empty-output'],
    [event(stop), 'empty-output'],
    [event(content()), 'missing-completion'],
    [': only a comment\n\n', 'missing-completion'],
    [
      event(JSON.stringify({ choices: [{ delta: { reasoning_content: 'hidden reasoning' }, finish_reason: 'stop' }] })),
      'empty-output'
    ]
  ])('never marks empty/unfinished/reasoning-only output as green (%s)', (body, outcome) => {
    const test = parser()
    test.push(body)
    expect(() => test.value.finish()).toThrow()
    expect(test.value.evidence).toMatchObject({ outcome, reachedEof: true })
  })

  it.each([
    ['{"choices":[{"message":{"content":"private response"},"finish_reason":"stop"}]}', 'json', 'json'],
    ['<html>private upstream page</html>', 'html', 'html']
  ])('recognizes a mismatched body instead of a generic missing marker', (body, contentType, framing) => {
    const test = parser(true, `text/${contentType}; token=private-parameter`)
    test.push(body)
    expect(() => test.value.finish()).toThrow()
    expect(test.value.evidence).toMatchObject({
      outcome: 'incompatible-protocol',
      framing,
      dataEvents: 0,
      reachedEof: true
    })
    expect(JSON.stringify(test.value.evidence)).not.toContain('private')
  })

  it.each([
    [{ type: 'content_block_delta', delta: { text: 'private anthropic' } }, 'anthropicEvents'],
    [{ candidates: [{ content: { parts: [{ text: 'private gemini' }] } }] }, 'geminiEvents'],
    [{ type: 'response.output_text.delta', delta: 'private response' }, 'responsesEvents']
  ])('detects other native protocols without pretending to convert them', (value, counter) => {
    const test = parser()
    expect(() => test.push(event(JSON.stringify(value)))).toThrow('其他原生协议')
    expect(test.value.evidence).toMatchObject({ outcome: 'incompatible-protocol', [counter]: 1, reachedEof: false })
    expect(JSON.stringify(test.value.evidence)).not.toContain('private')
  })

  it('never leaks malformed JSON text or arbitrary completion labels in diagnostics', () => {
    const test = parser()
    expect(() => test.push(event('{"private-malformed-password":'))).toThrow('未记录正文')
    expect(test.value.evidence).toMatchObject({ outcome: 'malformed-json', invalidJsonEvents: 1 })
    expect(JSON.stringify(test.value.evidence)).not.toContain('password')
    const unknown = parser()
    unknown.push(
      event(JSON.stringify({ choices: [{ delta: { content: 'secret answer' }, finish_reason: 'private-key-finish' }] }))
    )
    unknown.value.finish()
    expect(unknown.value.evidence.finishReasons).toEqual(['other'])
    expect(JSON.stringify(unknown.value.evidence)).not.toContain('secret')
    expect(JSON.stringify(unknown.value.evidence)).not.toContain('private-key')
  })

  it('records an explicit error even when an earlier event already finished', () => {
    const test = parser()
    test.push(event(content()) + event(stop) + event('[DONE]'))
    expect(() => test.push(event('{"error":{"message":"private error"}}'))).toThrow('upstream error')
    test.value.interrupted()
    expect(test.value.evidence).toMatchObject({ outcome: 'upstream-error', errorEvents: 1, reachedEof: false })
  })

  it('treats socket interruption as failure even after a completion marker was seen', () => {
    const test = parser()
    test.push(event(content()) + event(stop))
    test.value.interrupted()
    expect(test.value.evidence).toMatchObject({
      outcome: 'transport-interrupted',
      reachedEof: false,
      finishReasons: ['stop']
    })
  })

  it.each([true, false])(
    'fails invalid UTF8 rather than saving parser errors containing response bytes (stream=%s)',
    (stream) => {
      const test = parser(stream)
      test.value.push(new Uint8Array([0xe4]))
      expect(() => test.value.finish()).toThrow('UTF-8')
      expect(test.value.evidence.outcome).toBe('malformed-json')
    }
  )

  it('keeps event and response size limits', () => {
    const test = parser()
    expect(() => test.push('data: ' + 'x'.repeat(1024 * 1024))).toThrow('1MiB')
    expect(test.value.evidence.outcome).toBe('limit-exceeded')
    const body = parser(false)
    expect(() => body.value.push(new Uint8Array(16 * 1024 * 1024 + 1))).toThrow('证据限制')
  })

  it('preserves non-streaming JSON and usage-only final SSE events', () => {
    const json = parser(false, 'application/json')
    json.push(
      JSON.stringify({
        choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20 }
      })
    )
    json.value.finish()
    expect(json.value.evidence).toMatchObject({ outcome: 'complete', framing: 'json', usageEvents: 1 })
    const sse = parser(true, null)
    sse.push(event(content()) + event(stop) + event('{"choices":[],"usage":{"prompt_tokens":20}}') + event('[DONE]'))
    sse.value.finish()
    expect(sse.value.evidence).toMatchObject({
      outcome: 'complete',
      contentType: 'missing',
      usageEvents: 1,
      jsonEvents: 3
    })
  })
})
