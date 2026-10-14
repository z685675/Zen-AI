import { describe, expect, it } from 'vitest'

import {
  attributeDiagnostic,
  diagnosticFetch,
  DiagnosticRecorder,
  diagnosticText,
  sanitizeDiagnostic
} from '../diagnostics'

describe('diagnostic privacy and limits', () => {
  it('keeps token metrics but redacts keys in objects, JSON strings, stderr and URLs', () => {
    const result = sanitizeDiagnostic({
      input_tokens: 123,
      cached_tokens: 100,
      contextWindowTokens: 200000,
      apiKey: 'fake-secret',
      cause: JSON.stringify({ api_key: 'json-secret' }),
      stderr: 'API_KEY=plain-secret Authorization: "quoted-secret" Bearer bearer-secret',
      url: 'https://user:password@example.com/v1/chat?key=url-secret',
      proxy: 'socks5://proxy-user:proxy-secret@localhost:1080',
      imageUrl: 'data:image/png;base64,dGVzdC1pbWFnZS1jb250ZW50',
      env_vars: { PRIVATE_VALUE: 'env-secret' }
    })
    const text = JSON.stringify(result)
    for (const secret of [
      'fake-secret',
      'json-secret',
      'plain-secret',
      'quoted-secret',
      'bearer-secret',
      'url-secret',
      'proxy-user',
      'proxy-secret',
      'dGVzdC1pbWFnZS1jb250ZW50',
      'env-secret'
    ])
      expect(text).not.toContain(secret)
    expect(result).toMatchObject({
      input_tokens: 123,
      cached_tokens: 100,
      contextWindowTokens: 200000,
      url: 'https://example.com/v1/chat'
    })
  })
  it('preserves error tails, last array entries and cyclic causes', () => {
    expect(diagnosticText('x'.repeat(10000) + 'ROOT_CAUSE')).toContain('ROOT_CAUSE')
    expect(diagnosticText('x'.repeat(10000))).toContain('truncated')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(sanitizeDiagnostic(cyclic)).toEqual({ self: '[Circular]' })
    const items = sanitizeDiagnostic(Array.from({ length: 300 }, (_, i) => i)) as number[]
    expect(items.at(-1)).toBe(299)
  })
  it('bounds operations and events without mixing simultaneous requests', () => {
    const recorder = new DiagnosticRecorder(2, 6)
    recorder.begin('a', { apiKey: 'hidden' })
    recorder.begin('b')
    for (let i = 0; i < 10; i++) recorder.record('a', 'runtime', `event-${i}`)
    expect(recorder.get('a')?.events.at(-1)?.event).toBe('event-9')
    expect(recorder.get('a')?.droppedEvents).toBe(4)
    expect(recorder.get('b')?.events).toHaveLength(0)
    recorder.begin('c')
    expect(recorder.get('a')).toBeUndefined()
  })
})

describe('observed transport', () => {
  it('forwards unchanged stream bytes and records headers, first bytes and completion', async () => {
    const recorder = new DiagnosticRecorder()
    const body = 'data: {"content":"hello"}\n\ndata: [DONE]\n\n'
    const fetcher = diagnosticFetch(async (_, init) => {
      expect(new Headers(init?.headers).get('X-Zen-Diagnostic-Operation')).toBe('operation')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fake-key')
      return new Response(body, { headers: { 'x-oneapi-request-id': 'api-request', 'x-new-api-version': 'test' } })
    }, recorder.record.bind(recorder))
    const response = await fetcher('https://example.com/v1/chat/completions', {
      headers: { 'X-Zen-Diagnostic-Operation': 'operation', Authorization: 'Bearer fake-key' },
      body: JSON.stringify({ model: 'gpt-test', messages: [{ content: 'private prompt' }] })
    })
    expect(await response.text()).toBe(body)
    const events = recorder.get('operation')?.events ?? []
    expect(events.map((event) => event.event)).toEqual([
      'request-started',
      'headers-received',
      'first-bytes',
      'body-complete'
    ])
    expect(events[1].details).toMatchObject({ requestId: 'api-request', gateway: true })
    expect(JSON.stringify(events)).not.toContain('private prompt')
    expect(JSON.stringify(events)).not.toContain('fake-key')
  })
  it('records connection errors without claiming that the gateway received the request', async () => {
    const recorder = new DiagnosticRecorder()
    const fetcher = diagnosticFetch(async () => {
      throw new Error('fetch failed')
    }, recorder.record.bind(recorder))
    await expect(fetcher('https://example.com', { headers: { 'X-Zen-Diagnostic-Operation': 'op' } })).rejects.toThrow(
      'fetch failed'
    )
    expect(attributeDiagnostic(recorder.get('op')!.events)).toMatchObject({
      owner: 'network-or-proxy',
      confidence: 'suspected'
    })
  })
  it('records a read failure and retains the final upstream request ID', async () => {
    const recorder = new DiagnosticRecorder()
    const fetcher = diagnosticFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('broken body'))
            }
          }),
          { headers: { 'x-oneapi-request-id': 'req' } }
        ),
      recorder.record.bind(recorder)
    )
    const response = await fetcher('https://example.com', { headers: { 'X-Zen-Diagnostic-Operation': 'op' } })
    await expect(response.text()).rejects.toThrow('broken body')
    expect(recorder.get('op')?.events.at(-1)?.details).toMatchObject({ requestId: 'req', phase: 'read' })
    expect(recorder.get('op')?.events.some((event) => event.event === 'body-complete')).toBe(false)
  })
  it('preserves headers and the method supplied by a Request object', async () => {
    const recorder = new DiagnosticRecorder()
    const fetcher = diagnosticFetch(async (input, init) => {
      expect(input).toBeInstanceOf(Request)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-test-key')
      return new Response('ok')
    }, recorder.record.bind(recorder))
    const response = await fetcher(
      new Request('https://example.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer secret-test-key', 'X-Zen-Diagnostic-Operation': 'request-object' },
        body: '{}'
      })
    )
    expect(await response.text()).toBe('ok')
    expect(recorder.get('request-object')?.events[0].details?.method).toBe('POST')
  })
})

describe('evidence-based attribution', () => {
  it('attributes an observed unexpected active OpenCode exit but not a requested, idle or recovered exit', () => {
    const r = new DiagnosticRecorder()
    r.record('op', 'runtime', 'process-exit', { runtime: 'opencode', unexpected: true, active: true, code: 7 })
    expect(attributeDiagnostic(r.get('op')!.events)).toMatchObject({
      owner: 'zen-ai',
      stage: 'runtime-process',
      confidence: 'confirmed'
    })
    r.record('op', 'runtime', 'process-health', { runtime: 'opencode', healthy: true })
    expect(attributeDiagnostic(r.get('op')!.events).owner).toBe('undetermined')
    for (const details of [
      { unexpected: false, active: true, stopReason: 'user-cancelled' },
      { unexpected: true, active: false },
      { unexpected: false, active: false, stopReason: 'idle-timeout' }
    ]) {
      const normal = new DiagnosticRecorder()
      normal.record('op', 'runtime', 'process-exit', { runtime: 'opencode', ...details })
      expect(attributeDiagnostic(normal.get('op')!.events).owner).toBe('undetermined')
    }
  })
  const recorder = () => new DiagnosticRecorder()
  it('confirms local preparation, startup, rendering and persistence errors', () => {
    for (const stage of ['preparation', 'ui', 'storage'] as const) {
      const r = recorder()
      r.record('op', stage, 'failed', { error: 'test' })
      expect(attributeDiagnostic(r.get('op')!.events).owner).toBe('zen-ai')
    }
    const r = recorder()
    r.record('op', 'runtime', 'failed', { startup: true })
    expect(attributeDiagnostic(r.get('op')!.events)).toMatchObject({ owner: 'zen-ai', confidence: 'confirmed' })
  })
  it('does not mistake a generic SDK error for a local startup failure', () => {
    const r = recorder()
    r.record('op', 'runtime', 'failed', { error: 'API returned an error' })
    expect(attributeDiagnostic(r.get('op')!.events).owner).toBe('undetermined')
  })
  it('uses final API result rather than an earlier successfully recovered error', () => {
    const r = recorder()
    r.record('op', 'response', 'failed', { error: 'parse' })
    const result = attributeDiagnostic(r.get('op')!.events, [
      { requestId: 'first', outcome: 'failed', finishedAt: '2026-10-09T01:00:00Z' },
      { requestId: 'second', outcome: 'succeeded', writtenBytes: 100, finishedAt: '2026-10-09T01:00:01Z' }
    ])
    expect(result).toMatchObject({ owner: 'zen-ai', confidence: 'suspected' })
  })
  it('distinguishes API upstream failure from a failed downstream write', () => {
    expect(attributeDiagnostic([], [{ outcome: 'failed', failureStage: 'channel-upstream-response' }])).toMatchObject({
      owner: 'zen-api',
      confidence: 'confirmed'
    })
    expect(attributeDiagnostic([], [{ outcome: 'failed', failureStage: 'downstream-delivery' }])).toMatchObject({
      owner: 'network-or-proxy',
      confidence: 'suspected'
    })
  })
  it('never treats missing API evidence as proof that the server was not contacted', () => {
    expect(attributeDiagnostic([])).toMatchObject({ owner: 'undetermined', confidence: 'insufficient' })
  })
  it('does not use checkpoint completion or recovered key errors to classify the final request', () => {
    const r = recorder()
    r.record('op', 'transport', 'request-started', { traceId: 'checkpoint' })
    r.record('op', 'transport', 'body-complete', { traceId: 'checkpoint' })
    r.record('op', 'transport', 'failed', { traceId: 'checkpoint' })
    r.record('op', 'response', 'attempt-started')
    r.record('op', 'transport', 'request-started', { traceId: 'completion' })
    r.record('op', 'response', 'failed', { error: 'no answer' })
    expect(
      attributeDiagnostic(r.get('op')!.events, [
        { traceId: 'checkpoint', requestId: 'r1', outcome: 'succeeded', writtenBytes: 100 }
      ])
    ).toMatchObject({ owner: 'undetermined', confidence: 'insufficient' })
    r.record('op', 'transport', 'failed', { traceId: 'completion' })
    expect(attributeDiagnostic(r.get('op')!.events)).toMatchObject({ owner: 'network-or-proxy' })
  })
  it('does not reuse earlier HTTP evidence if a new attempt fails before fetch starts', () => {
    const r = recorder()
    r.record('op', 'transport', 'request-started', { traceId: 'first' })
    r.record('op', 'transport', 'headers-received', { traceId: 'first', status: 403, gateway: true })
    r.record('op', 'response', 'attempt-started')
    r.record('op', 'response', 'failed')
    expect(
      attributeDiagnostic(r.get('op')!.events, [{ traceId: 'first', outcome: 'failed', failureStage: 'gateway' }])
    ).toMatchObject({ owner: 'undetermined' })
  })
  it('does not assign a recovered runtime startup error to the final runtime', () => {
    const r = recorder()
    r.record('op', 'runtime', 'failed', { startup: true })
    r.record('op', 'runtime', 'fallback')
    r.record('op', 'runtime', 'started')
    r.record('op', 'runtime', 'failed', { error: 'upstream unavailable' })
    expect(
      attributeDiagnostic(r.get('op')!.events, [{ outcome: 'failed', failureStage: 'channel-upstream-response' }])
    ).toMatchObject({ owner: 'zen-api' })
  })
  it('retains definite local storage errors even if an outer handler records a generic failure', () => {
    const r = recorder()
    r.record('op', 'storage', 'failed', { error: 'disk full' })
    r.record('op', 'response', 'failed', { error: 'disk full' })
    expect(attributeDiagnostic(r.get('op')!.events)).toMatchObject({ owner: 'zen-ai', stage: 'storage' })
  })
  it('does not blame the client when a completely read HTTP 200 contains an API error', () => {
    const r = recorder()
    r.record('op', 'transport', 'request-started', { traceId: 'model' })
    r.record('op', 'transport', 'headers-received', { traceId: 'model', status: 200, gateway: true })
    r.record('op', 'transport', 'body-complete', { traceId: 'model' })
    r.record('op', 'response', 'failed', { error: { name: 'AI_APICallError', message: 'upstream stream error' } })
    expect(attributeDiagnostic(r.get('op')!.events)).toMatchObject({ owner: 'zen-api', confidence: 'suspected' })
  })
})
