import { describe, expect, it } from 'vitest'

import { OpenCodePerformance } from '../performance'
import { OpenCodeUsageObserver, OpenCodeUsageTotals } from '../usageObservation'

const bytes = (text: string) => new TextEncoder().encode(text)
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
function observe(value: unknown, contentType = 'application/json') {
  const observer = new OpenCodeUsageObserver(contentType)
  const body = contentType.includes('event-stream') ? frame(value) : JSON.stringify(value)
  observer.push(bytes(body))
  return observer.finish(true)
}

describe('bounded, passive upstream usage observations', () => {
  it('deduplicates cumulative OpenAI usage frames and keeps explicit cache zero', () => {
    const observer = new OpenCodeUsageObserver('text/event-stream')
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 5 }
    }
    observer.push(bytes(frame({ usage }) + frame({ usage }) + 'data: [DONE]\n\n'))
    expect(observer.finish(true)).toEqual({
      format: 'openai',
      complete: true,
      usage: { input: 100, output: 20, cacheRead: 0, reasoning: 5 }
    })
  })
  it('never infers a missing cache or usage field from a native default or total', () => {
    expect(observe({ usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }).usage).toEqual({
      input: 100,
      output: 5
    })
    expect(observe({ choices: [{ message: { content: 'hello' } }] }).usage).toEqual({})
  })
  it('captures Responses usage without counting the reasoning subset twice', () => {
    const result = observe(
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 80,
            output_tokens: 30,
            input_tokens_details: { cached_tokens: 60 },
            output_tokens_details: { reasoning_tokens: 10 }
          }
        }
      },
      'text/event-stream'
    )
    expect(result.usage).toEqual({ input: 80, output: 30, cacheRead: 60, reasoning: 10 })
  })
  it('merges Anthropic start/delta counters instead of summing snapshots', () => {
    const observer = new OpenCodeUsageObserver('text/event-stream')
    observer.push(
      bytes(
        frame({
          type: 'message_start',
          message: {
            usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 }
          }
        }) + frame({ type: 'message_delta', usage: { output_tokens: 15 } })
      )
    )
    expect(observer.finish(true)).toMatchObject({
      format: 'anthropic',
      usage: { input: 110, output: 15, cacheRead: 80, cacheWrite: 20 }
    })
  })
  it('reads native Gemini counters and includes separately reported thinking output', () => {
    expect(
      observe({
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 20,
          cachedContentTokenCount: 70
        }
      })
    ).toMatchObject({ format: 'gemini', usage: { input: 100, output: 30, reasoning: 20, cacheRead: 70 } })
  })
  it('reads Claude, Grok and Gemini converted through OpenAI like any compatible model', () => {
    for (const model of ['claude-test', 'grok-test', 'gemini-test', 'gpt-test']) {
      expect(
        observe({
          model,
          usage: { prompt_tokens: 50, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 30 } }
        }).usage
      ).toEqual({ input: 50, output: 3, cacheRead: 30 })
    }
  })
  it('handles split UTF-8, CRLF delimiters and multiline data', () => {
    const observer = new OpenCodeUsageObserver('text/event-stream; charset=utf-8')
    const body = bytes('data: {"text":"你好",\r\ndata: "usage":{"prompt_tokens":30,"completion_tokens":4}}\r\n\r\n')
    for (const byte of body) observer.push(new Uint8Array([byte]))
    expect(observer.finish(true).usage).toEqual({ input: 30, output: 4 })
  })
  it('skips invalid/oversized frames then still sees later final usage', () => {
    const observer = new OpenCodeUsageObserver('text/event-stream')
    observer.push(
      bytes(
        'data: not json\n\ndata: ' +
          'x'.repeat(400_000) +
          '\n\n' +
          frame({ usage: { prompt_tokens: 20, completion_tokens: 5 } })
      )
    )
    expect(observer.finish(true)).toMatchObject({ complete: false, usage: { input: 20, output: 5 } })
    const json = new OpenCodeUsageObserver('application/json')
    json.push(bytes('x'.repeat(2_000_000)))
    expect(json.finish(true)).toMatchObject({ complete: false, usage: {} })
  })
  it('rejects invalid numeric values and retains no response text or credentials', () => {
    const result = observe({
      api_key: 'sk-secret',
      text: 'private response',
      usage: {
        prompt_tokens: -1,
        completion_tokens: '20',
        prompt_tokens_details: { cached_tokens: null },
        cache_write_tokens: 1.25
      }
    })
    expect(result.usage).toEqual({})
    expect(JSON.stringify(result)).not.toMatch(/private|sk-secret|api_key/)
  })
  it('keeps reported partial usage for interrupted requests without claiming completeness', () => {
    const observer = new OpenCodeUsageObserver('text/event-stream')
    observer.push(bytes(frame({ usage: { prompt_tokens: 10, completion_tokens: 2 } })))
    expect(observer.finish(false)).toMatchObject({ complete: false, usage: { input: 10, output: 2 } })
  })
  it('aggregates one final observation per request, not stream frames', () => {
    const totals = new OpenCodeUsageTotals()
    totals.observe(
      observe({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } } })
    )
    totals.observe(observe({ usage: { prompt_tokens: 50, completion_tokens: 10 } }))
    totals.observe({ usage: {}, format: 'unknown', complete: false })
    expect(totals.snapshot('provider', 'model', new OpenCodePerformance().snapshot('failed'))).toMatchObject({
      observedRequests: 3,
      reportedRequests: 2,
      inputReports: 2,
      outputReports: 2,
      cacheReadReports: 1,
      cacheWriteReports: 0,
      incompleteRequests: 1,
      usage: { input: 150, output: 30, cacheRead: 80 }
    })
  })
})
