import { createServer } from 'node:http'

import { listenOnLoopback } from '@shared/utils/loopbackServer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createOpenCodeGateway } from '../gateway'

const cleanup: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const stop of cleanup.splice(0)) stop()
})
async function upstream(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler)
  await listenOnLoopback(server)
  cleanup.push(() => {
    server.closeAllConnections()
    server.close()
  })
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
}
describe('native Provider byte-transparent diagnostic bridge', () => {
  it('sends the first model request directly even when the old quota endpoint times out', async () => {
    let modelCalls = 0
    const permits: string[] = []
    const url = await upstream((req, res) => {
      if (req.url === '/api/usage/token/model-daily/turn/state') return res.end('{}')
      modelCalls++
      permits.push(String(req.headers['x-zen-model-turn']))
      expect(req.headers['x-zen-model-turn-mode']).toBe('inline-v1')
      res.end('{"choices":[]}')
    })
    const original = globalThis.fetch
    const oldEndpoint = new URL(url).origin + '/api/usage/token/model-daily/turn'
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) =>
        String(input) === oldEndpoint
          ? Promise.reject(new DOMException('timeout', 'TimeoutError'))
          : original(input, init)
      )
    const events: string[] = []
    const gateway = await createOpenCodeGateway(url, (_id, event) => events.push(event), 'premium')
    cleanup.push(gateway.stop)
    const response = await fetch(gateway.baseURL + '/chat/completions', {
      headers: { 'x-zen-runtime-token': gateway.token, Authorization: 'Bearer key' }
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(modelCalls).toBe(1)
    expect(permits[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(fetchMock.mock.calls.some(([input]) => String(input) === oldEndpoint)).toBe(false)
    expect(events).not.toContain('quota-check-started')
    expect(events).not.toContain('failed')
    await gateway.finishTurn()
  })
  it('shares one admitted capability across model calls, but gives the next question a fresh capability', async () => {
    let preflights = 0
    let closes = 0
    const permits: string[] = []
    const url = await upstream((req, res) => {
      if (req.url === '/api/usage/token/model-daily/turn') {
        preflights++
        return res.writeHead(503).end()
      }
      if (req.url === '/api/usage/token/model-daily/turn/state') {
        closes++
        return res.end('{}')
      }
      permits.push(String(req.headers['x-zen-model-turn']))
      expect(req.headers['x-zen-model-turn-mode']).toBe('inline-v1')
      res.end('{"choices":[]}')
    })
    const gateway = await createOpenCodeGateway(url, () => {}, 'premium')
    cleanup.push(gateway.stop)
    const ask = async () => {
      const response = await fetch(gateway.baseURL + '/chat/completions', {
        headers: {
          'x-zen-runtime-token': gateway.token,
          Authorization: 'Bearer key',
          'X-Zen-Model-Turn': 'forged',
          'X-Zen-Model-Turn-Mode': 'forged'
        }
      })
      expect(response.status).toBe(200)
      await response.text()
    }
    gateway.setOperation('first-question')
    await ask()
    await ask()
    expect(permits[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(permits[1]).toBe(permits[0])
    await gateway.finishTurn()
    expect(closes).toBe(1)
    gateway.setOperation('next-question')
    await ask()
    expect(permits[2]).not.toBe(permits[0])
    expect(preflights).toBe(0)
    await gateway.finishTurn()
  })
  it('forwards an API quota refusal from the formal request without retrying or calling an admission endpoint', async () => {
    let calls = 0
    const body =
      '{"error":{"code":"model_daily_token_limit_exceeded","message":"该模型额度已达到日限额，请切换其他模型使用。"}}'
    const url = await upstream((req, res) => {
      if (req.url === '/api/usage/token/model-daily/turn/state') return res.end('{}')
      calls++
      res
        .writeHead(403, {
          'Content-Type': 'application/json',
          'X-Zen-Model-Quota-Error': 'model_daily_token_limit_exceeded'
        })
        .end(body)
    })
    const events: Array<{ event: string; details: Record<string, unknown> }> = []
    const gateway = await createOpenCodeGateway(
      url,
      (_id, event, details) => events.push({ event, details }),
      'premium'
    )
    cleanup.push(gateway.stop)
    const response = await fetch(gateway.baseURL + '/chat/completions', {
      headers: { 'x-zen-runtime-token': gateway.token, Authorization: 'Bearer key' }
    })
    expect(response.status).toBe(403)
    expect(await response.text()).toBe(body)
    expect(calls).toBe(1)
    expect(events.find((entry) => entry.event === 'quota-refused')?.details).toMatchObject({
      phase: 'provider',
      status: 403,
      receivedResponse: true,
      error: { code: 'model_daily_token_limit_exceeded' }
    })
    expect(events.some((entry) => entry.event === 'quota-check-started' || entry.event === 'failed')).toBe(false)
    await gateway.finishTurn()
  })
  it('observes only numeric usage without changing fragmented response bytes or making another request', async () => {
    let calls = 0
    const body =
      'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":80}}}\r\n\r\ndata: [DONE]\r\n\r\n'
    const url = await upstream((_req, res) => {
      calls++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(body.slice(0, 17))
      res.end(body.slice(17))
    })
    const records: any[] = []
    const gateway = await createOpenCodeGateway(url, (_id, event, details) => records.push({ event, details }))
    cleanup.push(gateway.stop)
    const response = await fetch(`${gateway.baseURL}/chat/completions`, {
      headers: { 'x-zen-runtime-token': gateway.token }
    })
    expect(await response.text()).toBe(body)
    expect(calls).toBe(1)
    expect(records.filter((entry) => entry.event === 'usage-observed')).toEqual([
      {
        event: 'usage-observed',
        details: { complete: true, format: 'openai', usage: { input: 100, output: 20, cacheRead: 80 } }
      }
    ])
    expect(JSON.stringify(records)).not.toContain('你好')
    const attempts = records.filter((entry) =>
      ['request-started', 'headers-received', 'first-bytes', 'body-complete'].includes(entry.event)
    )
    expect(attempts.map((entry) => entry.event)).toEqual([
      'request-started',
      'headers-received',
      'first-bytes',
      'body-complete'
    ])
    expect(new Set(attempts.map((entry) => entry.details.transportRequestId)).size).toBe(1)
    expect(attempts[0].details.transportRequestId).toEqual(expect.any(String))
  })
  it('records a DNS/TLS failure before HTTP instead of confusing its synthetic 502 with upstream status', async () => {
    const originalFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      String(input).startsWith('https://local-fixture.invalid/')
        ? Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }))
        : originalFetch(input, init)
    )
    const records: any[] = []
    const gateway = await createOpenCodeGateway('https://local-fixture.invalid/v1', (_id, event, details) =>
      records.push({ event, details })
    )
    cleanup.push(gateway.stop)
    const response = await fetch(`${gateway.baseURL}/chat/completions`, {
      headers: { 'x-zen-runtime-token': gateway.token }
    })
    expect(response.status).toBe(502)
    await response.text()
    expect(records).toContainEqual({
      event: 'failed',
      details: expect.objectContaining({
        receivedResponse: false,
        url: 'https://local-fixture.invalid/v1/chat/completions',
        error: expect.objectContaining({ cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } })
      })
    })
    expect(records.some((item) => item.event === 'headers-received')).toBe(false)
  })
  it('forwards the body/protocol once, links each turn and removes loopback credentials', async () => {
    const received: any[] = []
    const url = await upstream(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString(), url: req.url })
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Oneapi-Request-Id': 'request-test' })
      res.end('data: {"text":"你好"}\n\ndata: [DONE]\n\n')
    })
    const records: any[] = []
    const gateway = await createOpenCodeGateway(url, (id, event, details) => records.push({ id, event, details }))
    cleanup.push(gateway.stop)
    const body = JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hello' }] })
    for (const id of ['turn-one', 'turn-two']) {
      gateway.setOperation(id)
      const response = await fetch(`${gateway.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'x-zen-runtime-token': gateway.token,
          'X-Zen-Task-Id': 'stale-provider-marker',
          Authorization: 'Bearer mock-key',
          'Content-Type': 'application/json'
        },
        body
      })
      expect(await response.text()).toContain('你好')
    }
    expect(received).toHaveLength(2)
    expect(received.map((item) => item.body)).toEqual([body, body])
    expect(received[0].headers['x-zen-runtime-token']).toBeUndefined()
    expect(received[0].headers.authorization).toBe('Bearer mock-key')
    expect(received.map((item) => item.headers['x-zen-diagnostic-operation'])).toEqual(['turn-one', 'turn-two'])
    expect(received.map((item) => item.headers['x-zen-task-id'])).toEqual(['turn-one', 'turn-two'])
    expect(records).toContainEqual(
      expect.objectContaining({
        id: 'turn-one',
        event: 'headers-received',
        details: expect.objectContaining({ requestId: 'request-test', status: 200 })
      })
    )
  })
  it('requires the owned token and does not follow redirects away from the configured service', async () => {
    let calls = 0
    const url = await upstream((_req, res) => {
      calls++
      res.writeHead(302, { Location: 'https://other.example/' }).end()
    })
    const gateway = await createOpenCodeGateway(url, () => {})
    cleanup.push(gateway.stop)
    expect((await fetch(`${gateway.baseURL}/chat/completions`)).status).toBe(401)
    expect(calls).toBe(0)
    const response = await fetch(`${gateway.baseURL}/chat/completions`, {
      headers: { 'x-zen-runtime-token': gateway.token },
      redirect: 'manual'
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBeNull()
    expect(calls).toBe(1)
  })
  it('preserves upstream status rather than claiming a routing outage is success', async () => {
    const url = await upstream((_req, res) => res.writeHead(503).end('{"error":{"message":"no channel"}}'))
    const gateway = await createOpenCodeGateway(url, () => {})
    cleanup.push(gateway.stop)
    const response = await fetch(`${gateway.baseURL}/chat/completions`, {
      headers: { 'x-zen-runtime-token': gateway.token }
    })
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('no channel')
  })
})
