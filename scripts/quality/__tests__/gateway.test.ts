import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, it } from 'vitest'

import { CONNECTIVITY_CHECK_REQUEST_HEADERS, TOPIC_NAMING_REQUEST_HEADERS } from '../../../packages/shared/diagnostics'
import { listenOnLoopback } from '../../../packages/shared/utils/loopbackServer'
import { openAIUsage, startBudgetGateway } from '../gateway'
import { RequestBudget } from '../live'
import { MoneyBudget, validatePrice } from '../pricing'

const price = () =>
  validatePrice({
    providerRef: 'local',
    modelId: 'chosen',
    currency: 'CNY',
    basis: 'key-charge',
    source: 'fixture',
    group: 'default',
    capturedAt: '2020-01-01T00:00:00Z',
    validUntil: '2099-01-01T00:00:00Z',
    tiers: [{ throughInputTokens: 200000, input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }]
  })

async function fixture(
  handler: Parameters<typeof createServer>[0],
  run: (
    gateway: Awaited<ReturnType<typeof startBudgetGateway>>,
    calls: () => number,
    money: MoneyBudget
  ) => Promise<void>,
  options: Partial<Parameters<typeof startBudgetGateway>[0]> = {}
) {
  let calls = 0
  const server = createServer((req, res) => {
    calls++
    ;(handler as any)(req, res)
  })
  await listenOnLoopback(server)
  const money = options.money ?? new MoneyBudget(1)
  const gateway = await startBudgetGateway({
    modelId: 'chosen',
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    credential: 'chosen-secret-only-upstream',
    price: price(),
    money,
    tokens: new RequestBudget({ maxRequests: 3, maxInputTokens: 600000, maxOutputTokens: 3000 }),
    maxInput: 200000,
    maxOutput: 1000,
    timeoutMs: 1500,
    ...options
  })
  try {
    await run(gateway, () => calls, money)
  } finally {
    await gateway.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const request = (gateway: Awaited<ReturnType<typeof startBudgetGateway>>, extra = {}, init: RequestInit = {}) =>
  fetch(gateway.url + '/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chosen', messages: [{ role: 'user', content: '你好' }], ...extra }),
    ...init
  })

const naming = (gateway: Awaited<ReturnType<typeof startBudgetGateway>>, extra = {}, init: RequestInit = {}) =>
  request(gateway, extra, {
    headers: {
      authorization: `Bearer ${gateway.token}`,
      'content-type': 'application/json',
      ...TOPIC_NAMING_REQUEST_HEADERS
    },
    ...init
  })

const connectivity = (
  gateway: Awaited<ReturnType<typeof startBudgetGateway>>,
  path = '/api/status',
  init: RequestInit = {}
) =>
  fetch(new URL(path, gateway.url), {
    headers: { authorization: `Bearer ${gateway.token}`, ...CONNECTIVITY_CHECK_REQUEST_HEADERS },
    ...init
  })

describe('quality per-call budget gateway', () => {
  it('handles explicit connectivity probes locally without spending or inventing upstream health/model evidence', async () => {
    const tokens = new RequestBudget({ maxRequests: 1, maxInputTokens: 200000, maxOutputTokens: 1000 })
    await fixture(
      () => {
        throw new Error('must not forward')
      },
      async (gateway, calls, money) => {
        gateway.beginTurn('diagnostic')
        const tokenSnapshot = tokens.snapshot()
        const moneySnapshot = money.snapshot()
        const status = await connectivity(gateway)
        expect(status.status).toBe(501)
        expect(await status.json()).toMatchObject({
          error: {
            message: expect.stringContaining('本地质检预算网关不支持上游健康检查'),
            source: 'budget-gateway',
            code: 'connectivity-check-unsupported'
          },
          local: true,
          forwarded: false,
          upstreamHealth: 'unknown'
        })
        const models = await connectivity(gateway, '/v1/models')
        expect(models.status).toBe(200)
        expect(await models.json()).toEqual({
          object: 'list',
          data: [{ id: 'chosen', object: 'model', owned_by: 'quality-selected' }]
        })
        // Preserve the existing locally synthesized model-list behavior without a marker, too.
        const unmarkedModels = await fetch(gateway.url + '/models', {
          headers: { authorization: `Bearer ${gateway.token}` }
        })
        expect(unmarkedModels.status).toBe(200)
        expect((await unmarkedModels.json()).data).toHaveLength(1)
        expect(gateway.rejected).toEqual([
          expect.objectContaining({
            turnId: 'diagnostic',
            purpose: 'connectivity-check',
            method: 'GET',
            path: '/api/status',
            failureImpact: 'warning'
          })
        ])
        expect(() => gateway.assertTurnHealthy('diagnostic')).not.toThrow()
        expect(gateway.turnWarnings('diagnostic')).toEqual([expect.stringContaining('连通性诊断未转发')])
        expect(gateway.turnWarnings('diagnostic')[0]).not.toContain('自动命名')
        expect(calls()).toBe(0)
        expect(gateway.calls).toEqual([]) // Local diagnostics cannot substitute for a successful main answer.
        expect(tokens.snapshot()).toEqual(tokenSnapshot)
        expect(money.snapshot()).toEqual(moneySnapshot)
      },
      { tokens }
    )
  })

  it.each(['/api/status', '/v1/models'])('requires local authorization for connectivity GET %s', async (path) => {
    await fixture(
      () => {
        throw new Error('must not forward')
      },
      async (gateway, calls, money) => {
        gateway.beginTurn('unauthorized-probe')
        const response = await connectivity(gateway, path, { headers: CONNECTIVITY_CHECK_REQUEST_HEADERS })
        expect(response.status).toBe(401)
        expect(calls()).toBe(0)
        expect(gateway.calls).toEqual([])
        expect(gateway.turnWarnings('unauthorized-probe')).toEqual([])
        expect(money.snapshot()).toMatchObject({ amount: 0, reserved: 0, unknownUsage: 0 })
      }
    )
  })

  it.each([undefined, 'topic-naming', 'unknown', 'CONNECTIVITY-CHECK', 'connectivity-check, topic-naming'])(
    'keeps status requests blocking without the exact connectivity marker (%s)',
    async (purpose) => {
      await fixture(
        () => {
          throw new Error('must not forward')
        },
        async (gateway, calls) => {
          gateway.beginTurn('unmarked-status')
          const response = await fetch(new URL('/api/status', gateway.url), {
            headers: {
              authorization: `Bearer ${gateway.token}`,
              ...(purpose ? { 'X-Zen-Request-Purpose': purpose } : {})
            }
          })
          expect(response.status).toBe(403)
          expect(gateway.rejected[0]).toMatchObject({ path: '/api/status', failureImpact: 'blocking' })
          expect(() => gateway.assertTurnHealthy('unmarked-status')).toThrow('被拒绝')
          expect(gateway.turnWarnings('unmarked-status')).toEqual([])
          expect(calls()).toBe(0)
        }
      )
    }
  )

  it.each([
    ['GET', '/unknown'],
    ['GET', '/v1/api/status'],
    ['GET', '/api/status/'],
    ['GET', '/api/%73tatus'],
    ['GET', '/api/status?token=query-private'],
    ['GET', '/v1/models/'],
    ['GET', '/v1/models?token=query-private'],
    ['POST', '/api/status'],
    ['HEAD', '/api/status'],
    ['OPTIONS', '/api/status'],
    ['POST', '/v1/models'],
    ['DELETE', '/v1/models'],
    ['GET', '/v1/chat/completions'],
    ['POST', '/v1/chat/completions'],
    ['POST', '/v1/responses']
  ])('keeps marked %s %s blocking without forwarding or reserving budget', async (method, path) => {
    const tokens = new RequestBudget({ maxRequests: 1, maxInputTokens: 200000, maxOutputTokens: 1000 })
    await fixture(
      () => {
        throw new Error('must not forward')
      },
      async (gateway, calls, money) => {
        gateway.beginTurn('invalid-probe')
        const tokenSnapshot = tokens.snapshot()
        const moneySnapshot = money.snapshot()
        const response = await connectivity(gateway, path, {
          method,
          ...(method === 'POST'
            ? { body: JSON.stringify({ model: 'chosen', messages: [{ role: 'user', content: '你好' }] }) }
            : {})
        })
        expect(response.status).toBe(403)
        expect(gateway.rejected[0]).toMatchObject({
          method,
          path: path.split('?')[0],
          purpose: 'connectivity-check',
          failureImpact: 'blocking'
        })
        expect(JSON.stringify(gateway.rejected)).not.toContain('query-private')
        // A later legitimate diagnostic must not erase an unknown route/method rejection.
        await (await connectivity(gateway)).text()
        expect(() => gateway.assertTurnHealthy('invalid-probe')).toThrow('被拒绝')
        expect(calls()).toBe(0)
        expect(gateway.calls).toEqual([])
        expect(tokens.snapshot()).toEqual(tokenSnapshot)
        expect(money.snapshot()).toEqual(moneySnapshot)
      },
      { tokens }
    )
  })

  it('keeps a successful main answer and later turns healthy after naming timeout and local connectivity probes', async () => {
    await fixture(
      (req: any, res: any) => {
        if (req.headers['x-zen-request-purpose'] === TOPIC_NAMING_REQUEST_HEADERS['X-Zen-Request-Purpose']) return
        res.end(JSON.stringify({ choices: [{ message: { content: '正常回答' }, finish_reason: 'stop' }] }))
      },
      async (gateway, calls, money) => {
        gateway.beginTurn('one')
        await (await request(gateway)).text()
        expect((await naming(gateway)).status).toBe(504)
        expect((await connectivity(gateway)).status).toBe(501)
        expect((await connectivity(gateway, '/v1/models')).status).toBe(200)
        expect(() => gateway.assertTurnHealthy('one')).not.toThrow()
        expect(gateway.turnWarnings('one')).toEqual([
          expect.stringContaining('自动命名失败'),
          expect.stringContaining('连通性诊断未转发')
        ])
        expect(gateway.calls).toHaveLength(2)
        expect(gateway.calls[0]).toMatchObject({ purpose: 'main-or-unclassified', status: 200, completed: true })
        expect(gateway.calls[1]).toMatchObject({ purpose: 'topic-naming', failureImpact: 'warning' })
        gateway.beginTurn('two')
        await (await request(gateway)).text()
        expect(() => gateway.assertTurnHealthy('two')).not.toThrow()
        expect(gateway.turnWarnings('two')).toEqual([])
        expect(calls()).toBe(3)
        expect(money.snapshot().unknownUsage).toBe(3)
      },
      { timeoutMs: 100, money: new MoneyBudget(3) }
    )
  })

  it.each(['/api/status', '/v1/models'])('does not reflect query secrets from a rejected probe to %s', async (path) => {
    await fixture(
      () => {
        throw new Error('must not forward')
      },
      async (gateway, calls) => {
        gateway.beginTurn('query-secrets')
        const response = await connectivity(
          gateway,
          `${path}?token=${gateway.token}&upstream=chosen-secret-only-upstream&note=query-private`
        )
        expect(response.status).toBe(403)
        const responseText = await response.text()
        expect(gateway.rejected[0]).toMatchObject({ path, failureImpact: 'blocking' })
        expect(() => gateway.assertTurnHealthy('query-secrets')).toThrow(`GET ${path}：`)
        let failure = ''
        try {
          gateway.assertTurnHealthy('query-secrets')
        } catch (error) {
          failure = String(error)
        }
        const evidence = JSON.stringify({
          responseText,
          failure,
          calls: gateway.calls,
          rejected: gateway.rejected,
          warnings: gateway.turnWarnings('query-secrets')
        })
        for (const secret of [gateway.token, 'chosen-secret-only-upstream', 'query-private'])
          expect(evidence).not.toContain(secret)
        expect(calls()).toBe(0)
      }
    )
  })

  it('does not let a conflicting compaction header turn a connectivity marker into a model-call permission', async () => {
    await fixture(
      () => {
        throw new Error('must not forward')
      },
      async (gateway, calls) => {
        gateway.beginTurn('conflicting-purpose')
        const response = await connectivity(gateway, '/v1/chat/completions', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${gateway.token}`,
            ...CONNECTIVITY_CHECK_REQUEST_HEADERS,
            'X-Zen-Context-Compaction': 'default-only'
          },
          body: JSON.stringify({ model: 'chosen', messages: [{ role: 'user', content: '你好' }] })
        })
        expect(response.status).toBe(403)
        expect(gateway.rejected[0]).toMatchObject({ purpose: 'connectivity-check', failureImpact: 'blocking' })
        expect(() => gateway.assertTurnHealthy('conflicting-purpose')).toThrow('被拒绝')
        expect(calls()).toBe(0)
      }
    )
  })

  it.each([400, 503])('does not let local connectivity probes hide a main HTTP %s failure', async (status) => {
    await fixture(
      (_req: any, res: any) => res.writeHead(status).end('{}'),
      async (gateway, calls) => {
        gateway.beginTurn('failed-main')
        await (await request(gateway)).text()
        await (await connectivity(gateway)).text()
        await (await connectivity(gateway, '/v1/models')).text()
        expect(() => gateway.assertTurnHealthy('failed-main')).toThrow(`HTTP ${status}`)
        expect(gateway.calls[0].failureImpact).toBe('blocking')
        expect(calls()).toBe(1)
      }
    )
  })

  it.each(['model', 'input', 'loop', 'tokens', 'money'])(
    'keeps the %s guard blocking after local connectivity probes',
    async (kind) => {
      await fixture(
        () => {
          throw new Error('must not forward')
        },
        async (gateway, calls) => {
          gateway.beginTurn('guard')
          await (await connectivity(gateway)).text()
          await (await connectivity(gateway, '/v1/models')).text()
          const extra =
            kind === 'model'
              ? { model: 'unauthorized' }
              : kind === 'input'
                ? { messages: [{ role: 'user', content: 'x'.repeat(200000) }] }
                : {}
          expect((await request(gateway, extra)).status).toBe(502)
          expect(() => gateway.assertTurnHealthy('guard')).toThrow('被拒绝')
          expect(gateway.rejected.at(-1)?.failureImpact).toBe('blocking')
          expect(calls()).toBe(0)
        },
        kind === 'loop'
          ? { maxRequestsPerTurn: 0 }
          : kind === 'tokens'
            ? { tokens: new RequestBudget({ maxRequests: 1, maxInputTokens: 1, maxOutputTokens: 1 }) }
            : kind === 'money'
              ? { money: new MoneyBudget(0.01) }
              : {}
      )
    }
  )

  it('warns on explicit naming failure, preserves its cost, and accepts further main calls/turns', async () => {
    let attempts = 0
    await fixture(
      (_req: any, res: any) => {
        if (++attempts === 1) res.writeHead(400).end('{}')
        else res.end(JSON.stringify({ choices: [{ message: { content: '正常回答' }, finish_reason: 'stop' }] }))
      },
      async (gateway, calls, money) => {
        gateway.beginTurn('one')
        await (await naming(gateway)).text()
        expect(gateway.calls[0]).toMatchObject({
          purpose: 'topic-naming',
          method: 'POST',
          path: '/v1/chat/completions',
          failureImpact: 'warning',
          completed: false
        })
        expect(() => gateway.assertTurnHealthy('one', true)).not.toThrow()
        await (await request(gateway)).text()
        expect(() => gateway.assertTurnHealthy('one')).not.toThrow()
        expect(gateway.turnWarnings('one')).toEqual([expect.stringContaining('自动命名失败')])
        gateway.beginTurn('two')
        await (await request(gateway)).text()
        expect(() => gateway.assertTurnHealthy('two')).not.toThrow()
        expect(gateway.turnWarnings('two')).toEqual([])
        expect(calls()).toBe(3)
        expect(money.snapshot().unknownUsage).toBe(3)
      },
      { money: new MoneyBudget(3) }
    )
  })

  it('treats a client-cancelled naming request as a warning, not a cancelled main answer', async () => {
    let received!: () => void
    const started = new Promise<void>((resolve) => {
      received = resolve
    })
    await fixture(
      () => received(),
      async (gateway) => {
        gateway.beginTurn('one')
        const controller = new AbortController()
        const pending = naming(gateway, {}, { signal: controller.signal }).catch(() => undefined)
        await started
        controller.abort()
        await pending
        await expect.poll(() => gateway.isIdle()).toBe(true)
        expect(gateway.calls[0]).toMatchObject({ errorSource: 'client', failureImpact: 'warning' })
        expect(() => gateway.assertTurnHealthy('one')).not.toThrow()
      }
    )
  })

  it.each(['timeout', 'empty', 'batch-cancel'] as const)(
    'classifies explicit naming %s without weakening global cancellation',
    async (kind) => {
      const controller = new AbortController()
      await fixture(
        (_req: any, res: any) => {
          if (kind === 'empty')
            res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }))
          else if (kind === 'batch-cancel') controller.abort()
        },
        async (gateway, calls, money) => {
          gateway.beginTurn('naming')
          // Invalid non-streaming bodies may close after the real headers were forwarded.
          await (await naming(gateway)).text().catch(() => '')
          expect(calls()).toBe(1)
          expect(money.snapshot().unknownUsage).toBe(1)
          expect(gateway.calls[0]).toMatchObject({
            purpose: 'topic-naming',
            completed: false,
            failureImpact: kind === 'batch-cancel' ? 'blocking' : 'warning'
          })
          if (kind === 'batch-cancel') {
            expect(gateway.calls[0].errorSource).toBe('caller')
            expect(() => gateway.assertTurnHealthy('naming')).toThrow('已取消')
            expect(gateway.turnWarnings('naming')).toEqual([])
          } else {
            expect(() => gateway.assertTurnHealthy('naming')).not.toThrow()
            expect(gateway.turnWarnings('naming')).toHaveLength(1)
          }
        },
        { timeoutMs: 100, signal: controller.signal }
      )
    }
  )

  it.each(['main', 'unknown', 'context', 'tool'])(
    'keeps %s errors blocking even when non-streaming and followed by successful naming',
    async (kind) => {
      let attempts = 0
      await fixture(
        (_req: any, res: any) => {
          if (++attempts === 1) res.writeHead(503).end('{}')
          else res.end(JSON.stringify({ choices: [{ message: { content: '标题成功' }, finish_reason: 'stop' }] }))
        },
        async (gateway) => {
          gateway.beginTurn('mixed')
          await (
            await request(
              gateway,
              kind === 'tool' ? { tools: [{ type: 'function', function: { name: 'read', parameters: {} } }] } : {},
              {
                headers: {
                  authorization: `Bearer ${gateway.token}`,
                  'content-type': 'application/json',
                  ...(kind === 'unknown' ? { 'X-Zen-Request-Purpose': 'some-other-summary' } : {}),
                  ...(kind === 'context'
                    ? { 'X-Zen-Context-Compaction': 'default-only', ...TOPIC_NAMING_REQUEST_HEADERS }
                    : {})
                }
              }
            )
          ).text()
          await (await naming(gateway)).text()
          expect(gateway.calls[0].purpose).toBe(kind === 'context' ? 'context-compaction' : 'main-or-unclassified')
          expect(() => gateway.assertTurnHealthy('mixed')).toThrow('HTTP 503')
          expect(gateway.turnWarnings('mixed')).toEqual([])
        }
      )
    }
  )

  it('records sanitized rejected routes and only warns for a known naming protocol fallback', async () => {
    await fixture(
      () => {
        throw new Error('must not forward')
      },
      async (gateway, calls) => {
        const headers = { authorization: `Bearer ${gateway.token}`, ...TOPIC_NAMING_REQUEST_HEADERS }
        gateway.beginTurn('naming-fallback')
        expect((await fetch(gateway.url + '/responses', { method: 'POST', headers })).status).toBe(403)
        expect(() => gateway.assertTurnHealthy('naming-fallback')).not.toThrow()
        expect(gateway.turnWarnings('naming-fallback')[0]).toContain('POST /v1/responses')
        gateway.beginTurn('main-fallback')
        await fetch(gateway.url + '/responses', {
          method: 'POST',
          headers: { authorization: `Bearer ${gateway.token}` }
        })
        expect(() => gateway.assertTurnHealthy('main-fallback')).toThrow('被拒绝')
        gateway.beginTurn('unsafe')
        await fetch(gateway.url + '/admin/chosen-secret-only-upstream?token=query-private&other=also-private', {
          headers
        })
        expect(() => gateway.assertTurnHealthy('unsafe')).toThrow('被拒绝')
        expect(gateway.rejected[2]).toMatchObject({
          method: 'GET',
          path: '/v1/admin/[REDACTED]',
          purpose: 'topic-naming',
          failureImpact: 'blocking'
        })
        expect(JSON.stringify(gateway.rejected)).not.toMatch(/chosen-secret-only-upstream|query-private|also-private/)
        expect(calls()).toBe(0)
      }
    )
  })

  it.each(['model', 'budget', 'input'])('does not downgrade a naming %s guard failure', async (kind) => {
    await fixture(
      () => {
        throw new Error('must not forward')
      },
      async (gateway, calls) => {
        gateway.beginTurn('guard')
        const extra =
          kind === 'model'
            ? { model: 'unauthorized' }
            : kind === 'input'
              ? { messages: [{ role: 'user', content: 'x'.repeat(200000) }] }
              : {}
        await (await naming(gateway, extra)).text()
        expect(() => gateway.assertTurnHealthy('guard')).toThrow('被拒绝')
        expect(gateway.turnWarnings('guard')).toEqual([])
        expect(calls()).toBe(0)
      },
      kind === 'budget' ? { maxRequestsPerTurn: 0 } : {}
    )
  })

  it('does not downgrade reported naming usage beyond its authorized reservation', async () => {
    await fixture(
      (_req: any, res: any) =>
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '标题' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 200001, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } }
          })
        ),
      async (gateway) => {
        gateway.beginTurn('overuse')
        await (await naming(gateway)).text()
        expect(gateway.calls[0].failureImpact).toBe('blocking')
        expect(() => gateway.assertTurnHealthy('overuse')).toThrow('超过')
      }
    )
  })

  it.each([2000, 8192])(
    'accounts for reasoning output against the approved %i reserve without hiding an overrun',
    async (reserve) => {
      const tokens = new RequestBudget({ maxRequests: 3, maxInputTokens: 600000, maxOutputTokens: 60000 })
      let sequence = 0
      await fixture(
        (_req: any, res: any) => {
          sequence++
          res.end(
            JSON.stringify({
              choices: [
                {
                  message:
                    sequence === 1
                      ? {
                          tool_calls: [
                            { id: 'one', type: 'function', function: { name: 'safe_read', arguments: '{}' } }
                          ]
                        }
                      : { content: '完成' },
                  finish_reason: sequence === 1 ? 'tool_calls' : 'stop'
                }
              ],
              usage: {
                prompt_tokens: 18660,
                completion_tokens: sequence === 1 ? 5033 : 10,
                prompt_tokens_details: { cached_tokens: 18496 },
                completion_tokens_details: { reasoning_tokens: sequence === 1 ? 4687 : 0 }
              }
            })
          )
        },
        async (gateway, calls) => {
          gateway.beginTurn('file-task')
          await (await request(gateway)).text()
          expect(gateway.calls[0]).toMatchObject({ status: 200, completed: true, usage: { output: 5033 } })
          if (reserve === 2000) {
            expect(gateway.calls[0]).toMatchObject({
              errorSource: 'budget-gateway',
              errorCode: 'request-token-limit',
              failureImpact: 'blocking',
              retryable: false,
              reservationExceeded: { input: 18660, maxInput: 200000, output: 5033, maxOutput: 2000 }
            })
            expect(() => gateway.assertTurnHealthy('file-task')).toThrow('输出5033/2000')
            expect((await request(gateway)).status).toBe(502)
            expect(calls()).toBe(1)
            expect(tokens.snapshot()).toMatchObject({ output: 5033, stopped: true })
          } else {
            expect(() => gateway.assertTurnHealthy('file-task')).not.toThrow()
            expect(gateway.calls[0].reservationExceeded).toBeUndefined()
            await (await request(gateway)).text()
            expect(() => gateway.assertTurnHealthy('file-task')).not.toThrow()
            expect(calls()).toBe(2)
            expect(tokens.snapshot()).toMatchObject({ output: 5043, stopped: false })
          }
        },
        { tokens, maxOutput: reserve }
      )
    }
  )

  it.each(['max_tokens', 'max_completion_tokens'])(
    'keeps a smaller native %s limit and caps larger limits',
    async (key) => {
      const received: Record<string, number>[] = []
      await fixture(
        async (req: any, res: any) => {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk)
          received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          res.end(JSON.stringify({ choices: [{ message: { content: '完成' }, finish_reason: 'stop' }] }))
        },
        async (gateway) => {
          gateway.beginTurn('bounded')
          for (const limit of [64, 999999]) await (await request(gateway, { [key]: limit })).text()
          expect(received.map((value) => value[key])).toEqual([64, 1000])
          if (key === 'max_completion_tokens') expect(received.every((value) => !('max_tokens' in value))).toBe(true)
        },
        { money: new MoneyBudget(3) }
      )
    }
  )

  it.each([0, -1, 1.5, '1000', null])(
    'refuses malformed native output limits (%s) without upstream spending',
    async (limit) => {
      await fixture(
        () => {
          throw new Error('must not forward')
        },
        async (gateway, calls) => {
          gateway.beginTurn('bad-limit')
          expect((await request(gateway, { max_tokens: limit })).status).toBe(502)
          expect(calls()).toBe(0)
          expect(() => gateway.assertTurnHealthy('bad-limit')).toThrow('正整数')
        }
      )
    }
  )

  it('preserves a retryable HTTP failure and accounts for the native retry that recovers the same request', async () => {
    let attempts = 0
    await fixture(
      (_req: any, res: any) => {
        if (++attempts === 1)
          res.writeHead(503).end(
            JSON.stringify({
              error: { message: 'No available channel; chosen-secret-only-upstream' },
              request_id: 'retry-7319'
            })
          )
        else res.end(JSON.stringify({ choices: [{ message: { content: '恢复成功' }, finish_reason: 'stop' }] }))
      },
      async (gateway, calls, money) => {
        gateway.beginTurn('failed-turn')
        const failed = await request(gateway)
        expect(failed.status).toBe(503)
        expect(await failed.text()).toContain('No available channel')
        expect(calls()).toBe(1) // The gateway never starts a retry itself.
        expect(gateway.calls[0]).toMatchObject({
          status: 503,
          retryable: true,
          completed: false,
          requestId: 'retry-7319'
        })
        expect(() => gateway.assertTurnHealthy('failed-turn', true)).not.toThrow()
        expect(() => gateway.assertTurnHealthy('failed-turn')).toThrow('HTTP 503')
        await (await request(gateway)).text()
        expect(calls()).toBe(2)
        expect(() => gateway.assertTurnHealthy('failed-turn')).not.toThrow()
        expect(gateway.calls[1].requestDigest).toBe(gateway.calls[0].requestDigest)
        expect(money.snapshot().unknownUsage).toBe(2)
        expect(JSON.stringify(gateway.calls)).not.toContain('chosen-secret-only-upstream')
      },
      { money: new MoneyBudget(3) }
    )
  })

  it('does not let a successful auxiliary request hide an unrecovered failure', async () => {
    let attempts = 0
    await fixture(
      (_req: any, res: any) => {
        if (++attempts === 1) res.writeHead(503).end('{}')
        else res.end(JSON.stringify({ choices: [{ message: { content: '其他请求成功' }, finish_reason: 'stop' }] }))
      },
      async (gateway) => {
        gateway.beginTurn('mixed')
        await (await request(gateway)).text()
        await (await request(gateway, { messages: [{ role: 'user', content: 'different auxiliary request' }] })).text()
        expect(() => gateway.assertTurnHealthy('mixed')).toThrow('HTTP 503')
      }
    )
  })

  it('still rejects non-retryable failures and limits repeated native attempts', async () => {
    await fixture(
      (_req: any, res: any) => res.writeHead(400).end('{}'),
      async (gateway, calls) => {
        gateway.beginTurn('invalid')
        expect((await request(gateway)).status).toBe(400)
        expect(() => gateway.assertTurnHealthy('invalid', true)).toThrow('HTTP 400')
        await (await request(gateway)).text()
        expect(calls()).toBe(1)
      }
    )
    await fixture(
      (_req: any, res: any) => res.writeHead(503).end('{}'),
      async (gateway, calls, money) => {
        gateway.beginTurn('unavailable')
        await (await request(gateway)).text()
        await (await request(gateway)).text()
        expect((await request(gateway)).status).toBe(502)
        expect(calls()).toBe(2)
        expect(money.snapshot().unknownUsage).toBe(2)
        expect(() => gateway.assertTurnHealthy('unavailable', true)).toThrow('上限')
      },
      { maxRequestsPerTurn: 2, money: new MoneyBudget(3) }
    )
  })

  it.each([
    ['empty', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', '空响应'],
    ['error event', 'data: {"error":{"message":"chosen-secret-only-upstream"}}\n\n', '错误事件'],
    ['error finish', 'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"error"}]}\n\n', '失败完成状态']
  ])('does not count an HTTP 200 %s stream as a successful call', async (_name, payload, expected) => {
    await fixture(
      (_req: any, res: any) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(payload),
      async (gateway) => {
        gateway.beginTurn('failed-stream')
        await (await request(gateway, { stream: true })).text().catch(() => '')
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(gateway.calls[0]).toMatchObject({ status: 200, completed: false })
        expect(() => gateway.assertTurnHealthy('failed-stream')).toThrow(expected)
        expect(JSON.stringify(gateway.calls)).not.toContain('chosen-secret-only-upstream')
      }
    )
  })

  it('runs unpriced only with explicit acknowledgement, retains Token/loop limits and reports null not free', async () => {
    await fixture(
      (_req: any, res: any) =>
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } }
          })
        ),
      async (gateway, calls, money) => {
        gateway.beginTurn('unpriced')
        await (await request(gateway)).text()
        expect(gateway.calls[0]).toMatchObject({
          amount: null,
          amountBasis: 'unpriced',
          usage: { input: 100, cacheRead: 80 }
        })
        expect((await request(gateway)).status).toBe(502)
        expect(calls()).toBe(1)
        expect(money.snapshot().amount).toBe(0) // This fixture's unused money ledger was NOT used by this gateway.
        gateway.beginTurn('next')
        expect((await request(gateway)).status).toBe(502)
        expect(calls()).toBe(1)
      },
      {
        price: undefined,
        money: undefined,
        acknowledgedUnknownCost: true,
        maxRequestsPerTurn: 1,
        tokens: new RequestBudget({ maxRequests: 1, maxInputTokens: 200000, maxOutputTokens: 1000 })
      }
    )
    await expect(
      startBudgetGateway({
        modelId: 'chosen',
        baseURL: 'https://never-called.invalid/v1',
        credential: 'not-sent',
        maxInput: 200000,
        maxOutput: 1000,
        timeoutMs: 1000,
        tokens: new RequestBudget({ maxRequests: 1, maxInputTokens: 200000, maxOutputTokens: 1000 })
      })
    ).rejects.toThrow('明确确认')
  })
  it('does not turn missing cache statistics into zero', () => {
    expect(openAIUsage({ prompt_tokens: 100, completion_tokens: 10 })).toBeUndefined()
    expect(
      openAIUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } })
    ).toEqual({ input: 100, output: 10, cacheRead: 80, cacheWrite: 0 })
  })
  it('rejects unauthorised turns/models/multimodal without sending upstream', async () => {
    await fixture(
      (_req: any, res: any) => res.end('{}'),
      async (gateway, calls) => {
        expect((await request(gateway)).status).toBe(502)
        gateway.beginTurn('turn-1')
        expect((await request(gateway, { model: 'unapproved' })).status).toBe(502)
        expect(
          (await request(gateway, { messages: [{ content: [{ type: 'image_url', image_url: 'data:fake' }] }] })).status
        ).toBe(502)
        for (const extra of [
          { audio: { format: 'wav' } },
          { modalities: ['audio'] },
          { web_search_options: {} },
          { tools: [{ type: 'web_search_preview' }] },
          { extra_body: { service_tier: 'priority' } }
        ])
          expect((await request(gateway, extra)).status).toBe(502)
        expect(calls()).toBe(0)
      }
    )
  })
  it('injects only selected credential, caps output, and counts all successful calls', async () => {
    await fixture(
      async (req: any, res: any) => {
        expect(req.headers.authorization).toBe('Bearer chosen-secret-only-upstream')
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        expect(JSON.parse(Buffer.concat(chunks).toString()).max_tokens).toBe(1000)
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 8000 } }
          })
        )
      },
      async (gateway, calls, money) => {
        gateway.beginTurn('turn-1')
        expect((await request(gateway, { max_tokens: 999999 })).status).toBe(200)
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(calls()).toBe(1)
        expect(gateway.calls[0]).toMatchObject({ completed: true, usageKnown: true, turnId: 'turn-1' })
        expect(money.snapshot().amount).toBeCloseTo(0.0049)
      }
    )
  })
  it('enforces a per-user-turn loop cap and preserves an exact upstream request ID', async () => {
    await fixture(
      (_req: any, res: any) => {
        res.setHeader('x-request-id', 'request-7319')
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } }
          })
        )
      },
      async (gateway, calls) => {
        gateway.beginTurn('one')
        await (await request(gateway)).text()
        expect(gateway.calls[0].requestId).toBe('request-7319')
        expect((await request(gateway)).status).toBe(502)
        expect(calls()).toBe(1)
        gateway.beginTurn('two')
        expect((await request(gateway)).status).toBe(200)
        expect(calls()).toBe(2)
      },
      { maxRequestsPerTurn: 1 }
    )
  })
  it('deep sizing uses the product estimator rather than blocking CJK on byte length alone', async () => {
    const handler = (_req: any, res: any) =>
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } }
        })
      )
    const content = '本记录为合成测试资料。'.repeat(1000)
    await fixture(
      handler,
      async (gateway, calls) => {
        gateway.beginTurn('conservative')
        expect((await request(gateway, { messages: [{ role: 'user', content }] })).status).toBe(502)
        expect(calls()).toBe(0)
      },
      { maxInput: 20000 }
    )
    await fixture(
      handler,
      async (gateway, calls) => {
        gateway.beginTurn('acknowledged-estimate')
        expect((await request(gateway, { messages: [{ role: 'user', content }] })).status).toBe(200)
        expect(calls()).toBe(1)
      },
      { maxInput: 20000, approximateInputSizing: true }
    )
  })
  it('reports numerical input preflight evidence and forwards the entire approved CJK history in estimated mode', async () => {
    const messages = [
      { role: 'user', content: '合成的中文历史'.repeat(5500) },
      { role: 'assistant', content: '合成的历史回复'.repeat(1000) },
      { role: 'user', content: '只需记住资料，不要输出文件。' }
    ]
    const tools = [
      { type: 'function', function: { name: 'fixture', description: '合成工具'.repeat(100), parameters: {} } }
    ]
    await fixture(
      async (req: any, res: any) => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        expect(received.messages).toEqual(messages)
        expect(received.tools).toEqual(tools)
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '记住了' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 45000,
              completion_tokens: 10,
              prompt_tokens_details: { cached_tokens: 30000 }
            }
          })
        )
      },
      async (gateway, calls) => {
        gateway.beginTurn('cjk-history')
        await (await request(gateway, { messages, tools })).text()
        expect(calls()).toBe(1)
        expect(gateway.calls[0]).toMatchObject({
          completed: true,
          inputSizing: {
            strategy: 'estimated-tokens',
            safetyMultiplier: 2,
            overheadTokens: 4096,
            maxInputTokens: 128000
          }
        })
        const sizing = gateway.calls[0].inputSizing!
        expect(sizing.textAndToolsBytes).toBeGreaterThan(128000)
        expect(sizing.estimatedInputTokens).toBeLessThan(128000)
        expect(JSON.stringify(sizing)).not.toContain('合成')
      },
      {
        inputSizing: 'estimated-tokens',
        price: undefined,
        money: undefined,
        acknowledgedUnknownCost: true,
        maxInput: 128000
      }
    )
  })

  it('does not send or spend for an oversized estimate and records the exact numbers without content', async () => {
    await fixture(
      (_req: any, res: any) => res.end('{}'),
      async (gateway, calls, money) => {
        gateway.beginTurn('oversized-estimate')
        const response = await request(gateway, { messages: [{ role: 'user', content: '合成隐私'.repeat(20000) }] })
        expect(response.status).toBe(502)
        expect(await response.text()).toContain('预检/预留')
        expect(calls()).toBe(0)
        expect(gateway.calls).toHaveLength(0)
        expect(gateway.rejected[0]).toMatchObject({
          inputSizing: { strategy: 'estimated-tokens', maxInputTokens: 128000 }
        })
        const sizing = gateway.rejected[0].inputSizing!
        expect(sizing.estimatedInputTokens).toBeGreaterThan(sizing.maxInputTokens)
        expect(JSON.stringify(gateway.rejected)).not.toContain('合成隐私')
        expect(money.snapshot()).toMatchObject({ amount: 0, reserved: 0, unknownUsage: 0 })
      },
      {
        inputSizing: 'estimated-tokens',
        price: undefined,
        money: undefined,
        acknowledgedUnknownCost: true,
        maxInput: 128000
      }
    )
  })

  it('still reserves the full approved amount and stops after actual input exceeds it in estimated mode', async () => {
    const tokens = new RequestBudget({ maxRequests: 3, maxInputTokens: 600000, maxOutputTokens: 3000 })
    await fixture(
      (_req: any, res: any) =>
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 129000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } }
          })
        ),
      async (gateway, calls) => {
        gateway.beginTurn('actual-overflow')
        await (await request(gateway)).text()
        expect(gateway.calls[0]).toMatchObject({
          errorCode: 'request-token-limit',
          reservationExceeded: { input: 129000, maxInput: 128000 }
        })
        expect(() => gateway.assertTurnHealthy('actual-overflow')).toThrow('request-token-limit')
        expect(tokens.snapshot()).toMatchObject({ input: 129000, output: 10, stopped: true })
        await (await request(gateway)).text()
        expect(calls()).toBe(1)
      },
      {
        tokens,
        inputSizing: 'estimated-tokens',
        price: undefined,
        money: undefined,
        acknowledgedUnknownCost: true,
        maxInput: 128000
      }
    )
  })
  it('accepts explicitly reserved inline vision but refuses unapproved external image URLs', async () => {
    await fixture(
      (_req: any, res: any) =>
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '图片' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } }
          })
        ),
      async (gateway, calls) => {
        gateway.beginTurn('vision')
        expect(
          (
            await request(gateway, {
              messages: [
                {
                  role: 'user',
                  content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,c3ludGhldGlj' } }]
                }
              ]
            })
          ).status
        ).toBe(200)
        expect(
          (
            await request(gateway, {
              messages: [
                {
                  role: 'user',
                  content: [{ type: 'image_url', image_url: { url: 'https://unapproved.example/image.png' } }]
                }
              ]
            })
          ).status
        ).toBe(502)
        expect(calls()).toBe(1)
      },
      { vision: { acknowledgedTokenBilling: true, maxImageTokensPerRequest: 20000 } }
    )
  })
  it('never retries 429 or redirects with credentials, and holds missing usage at maximum', async () => {
    await fixture(
      (_req: any, res: any) => res.writeHead(429).end('sensitive upstream body'),
      async (gateway, calls, money) => {
        gateway.beginTurn('turn-1')
        await request(gateway)
        expect(calls()).toBe(1)
        expect(money.snapshot().unknownUsage).toBe(1)
        expect(JSON.stringify(gateway.calls)).not.toContain('sensitive')
      }
    )
    await fixture(
      (_req: any, res: any) => res.writeHead(302, { location: 'https://unapproved.example' }).end(),
      async (gateway, calls) => {
        gateway.beginTurn('turn-1')
        expect((await request(gateway)).status).toBe(502)
        expect(calls()).toBe(1)
      }
    )
  })
  it('parses UTF8 fragmented streaming usage and refuses partial completion as success', async () => {
    await fixture(
      (_req: any, res: any) => {
        res.setHeader('content-type', 'text/event-stream')
        const bytes = Buffer.from(
          'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":80}}}\n\ndata: [DONE]\n\n'
        )
        res.write(bytes.subarray(0, 60))
        res.end(bytes.subarray(60))
      },
      async (gateway) => {
        gateway.beginTurn('turn-1')
        const response = await request(gateway, { stream: true })
        await response.text()
        expect(gateway.calls[0]).toMatchObject({ completed: true, usage: { input: 100, cacheRead: 80 } })
      }
    )
    await fixture(
      (_req: any, res: any) => {
        res.setHeader('content-type', 'text/event-stream')
        res.end('data: {"choices":[{"delta":{"content":"半条回答"},"finish_reason":null}]}\n\n')
      },
      async (gateway, calls, money) => {
        gateway.beginTurn('partial-turn')
        const response = await request(gateway, { stream: true })
        await response.text().catch(() => '')
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(calls()).toBe(1)
        expect(gateway.calls[0]).toMatchObject({ completed: false, usageKnown: false })
        expect(gateway.calls[0].error).toContain('最终完成标记')
        expect(money.snapshot()).toMatchObject({ unknownUsage: 1, inFlight: 0 })
        expect(money.snapshot().amount).toBeGreaterThan(0)
      }
    )
  })
  it('recognizes DONE with real output but no finish_reason without altering the forwarded response', async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"合成回复"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":80}}}\n\ndata: [DONE]\n\n'
    await fixture(
      (_req: any, res: any) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(body),
      async (gateway, calls) => {
        gateway.beginTurn('done-only-marker')
        expect(await (await request(gateway, { stream: true })).text()).toBe(body)
        expect(calls()).toBe(1)
        expect(gateway.calls[0]).toMatchObject({
          completed: true,
          usageKnown: true,
          response: {
            contentType: 'sse',
            framing: 'sse',
            dataEvents: 3,
            sawDone: true,
            finishReasons: [],
            hasText: true,
            outcome: 'complete',
            reachedEof: true
          }
        })
        expect(() => gateway.assertTurnHealthy('done-only-marker')).not.toThrow()
      }
    )
  })

  it.each([
    ['', 'text/event-stream', 'empty-body', 'unknown'],
    ['data: [DONE]\n\n', 'text/event-stream', 'empty-output', 'sse'],
    ['data: {"choices":[{"delta":{"content":"合成文本"}}]}\n\n', 'text/event-stream', 'missing-completion', 'sse'],
    [
      '{"choices":[{"message":{"content":"JSON合成文本"},"finish_reason":"stop"}]}',
      'application/json',
      'incompatible-protocol',
      'json'
    ],
    ['data: {"candidates":[]}\n\n', 'text/event-stream', 'incompatible-protocol', 'sse'],
    ['<html>private upstream content</html>', 'text/html', 'incompatible-protocol', 'html'],
    ['data: {"private-malformed":\n\n', 'text/event-stream', 'malformed-json', 'sse']
  ])('diagnoses HTTP 200 failure structurally (%s)', async (body, mime, outcome, framing) => {
    await fixture(
      (_req: any, res: any) => res.writeHead(200, { 'content-type': mime + '; private=private-parameter' }).end(body),
      async (gateway, calls, money) => {
        gateway.beginTurn('broken-stream')
        await (await request(gateway, { stream: true })).text()
        expect(calls()).toBe(1)
        expect(gateway.calls[0]).toMatchObject({
          status: 200,
          completed: false,
          errorCode: 'upstream-stream-error',
          response: { outcome, framing }
        })
        expect(() => gateway.assertTurnHealthy('broken-stream')).toThrow()
        expect(money.snapshot().unknownUsage).toBe(1)
        const evidence = JSON.stringify(gateway.calls)
        expect(evidence).not.toContain('private')
        expect(evidence).not.toContain('合成文本')
        if (framing === 'json') expect(gateway.calls[0].firstTextMs).toBeNull()
      }
    )
  })
  it('audits an unsupported API path without forwarding or spending the reservation', async () => {
    await fixture(
      (_req: any, res: any) => res.end('{}'),
      async (gateway, calls, money) => {
        gateway.beginTurn('blocked-path')
        const response = await fetch(gateway.url + '/responses', {
          method: 'POST',
          headers: { authorization: `Bearer ${gateway.token}` }
        })
        expect(response.status).toBe(403)
        expect(calls()).toBe(0)
        expect(gateway.rejected).toEqual([
          {
            turnId: 'blocked-path',
            reason: '未授权的接口路径/方法；未转发。',
            method: 'POST',
            path: '/v1/responses',
            purpose: 'main-or-unclassified',
            failureImpact: 'blocking'
          }
        ])
        expect(money.snapshot()).toMatchObject({ amount: 0, reserved: 0, unknownUsage: 0 })
      }
    )
  })
  it('closes in-flight requests and conservatively reconciles cancellation', async () => {
    let upstreamStarted!: () => void
    const started = new Promise<void>((resolve) => (upstreamStarted = resolve))
    await fixture(
      () => upstreamStarted(),
      async (gateway, calls, money) => {
        gateway.beginTurn('cancelled-turn')
        const pending = request(gateway).catch(() => undefined)
        await started
        await gateway.close()
        await pending
        expect(calls()).toBe(1)
        expect(gateway.isIdle()).toBe(true)
        expect(gateway.calls[0]).toMatchObject({ completed: false, usageKnown: false })
        expect(gateway.calls[0]).toMatchObject({
          errorSource: 'budget-gateway',
          errorCode: 'cancelled',
          retryable: false
        })
        expect(gateway.calls[0].error).not.toContain('request-timeout')
        expect(money.snapshot()).toMatchObject({ unknownUsage: 1, inFlight: 0 })
      }
    )
  })

  it('allows a delayed first token within the configured finite request limit', async () => {
    await fixture(
      (_req: any, res: any) => {
        // Scaled slow-header/first-token fixture, entirely on loopback with no paid model calls.
        const timer = setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'x-oneapi-request-id': 'slow-first-81' })
          res.end('data: {"choices":[{"delta":{"content":"迟到但成功"},"finish_reason":"stop"}]}\n\n')
        }, 100)
        res.once('close', () => clearTimeout(timer))
      },
      async (gateway) => {
        gateway.beginTurn('slow-first')
        const response = await request(gateway, { stream: true })
        expect(await response.text()).toContain('迟到但成功')
        expect(response.headers.get('x-request-id')).toBe('slow-first-81')
        expect(gateway.calls[0]).toMatchObject({ completed: true, requestId: 'slow-first-81' })
        expect(gateway.calls[0].firstTextMs).toBeGreaterThanOrEqual(90)
        expect(gateway.calls[0].error).toBeUndefined()
      },
      { timeoutMs: 1500 }
    )
  })

  it('flushes actual streaming headers before any content is available and records the waits separately', async () => {
    let sendContent!: () => void
    await fixture(
      (_req: any, res: any) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-oneapi-request-id': 'headers-before-content' })
        res.flushHeaders()
        sendContent = () =>
          res.end('data: {"choices":[{"delta":{"content":"headers之后的正文"},"finish_reason":"stop"}]}\n\n')
      },
      async (gateway) => {
        gateway.beginTurn('headers-first')
        const response = await request(gateway, { stream: true })
        expect(response.status).toBe(200)
        expect(response.headers.get('x-request-id')).toBe('headers-before-content')
        expect(gateway.calls[0]).toMatchObject({ status: 200, firstTextMs: null, completed: false })
        expect(gateway.calls[0].headerWaitMs).toEqual(expect.any(Number))
        // The upstream has not sent a single body byte: fetch can only return if the gateway flushed headers.
        sendContent()
        expect(await response.text()).toContain('headers之后的正文')
        expect(gateway.calls[0]).toMatchObject({ completed: true })
        expect(gateway.calls[0].firstTextMs!).toBeGreaterThanOrEqual(gateway.calls[0].headerWaitMs!)
      }
    )
  })

  it.each([false, true])(
    'enforces an explicit shorter budget and stops upstream (headers received: %s)',
    async (headers) => {
      let disconnected = false
      const tokens = new RequestBudget({ maxRequests: 3, maxInputTokens: 600000, maxOutputTokens: 3000 })
      await fixture(
        (req: any, res: any) => {
          req.resume()
          res.once('close', () => (disconnected = true))
          if (headers) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'x-oneapi-request-id': 'timeout-body-7319' })
            res.write('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n')
          }
        },
        async (gateway, calls, money) => {
          gateway.beginTurn('short-budget')
          const response = await request(gateway, { stream: true })
          const text = await response.text()
          expect(response.status).toBe(headers ? 200 : 504)
          const payload = headers ? JSON.parse(text.trim().split('data: ').at(-1)!) : JSON.parse(text)
          expect(payload.error).toMatchObject({
            source: 'budget-gateway',
            code: 'request-timeout',
            phase: headers ? 'upstream-body' : 'upstream-headers'
          })
          expect(payload.error.message).toContain('100ms')
          expect(payload.error.originalError).toHaveProperty('message')
          expect(gateway.calls[0]).toMatchObject({
            completed: false,
            errorSource: 'budget-gateway',
            errorCode: 'request-timeout',
            errorPhase: headers ? 'upstream-body' : 'upstream-headers',
            retryable: false
          })
          if (headers) {
            expect(payload.error.request_id).toBe('timeout-body-7319')
            expect(gateway.calls[0].requestId).toBe('timeout-body-7319')
          }
          await expect.poll(() => disconnected).toBe(true)
          expect(() => gateway.assertTurnHealthy('short-budget', true)).toThrow('budget-gateway/request-timeout')
          await (await request(gateway)).text()
          expect(calls()).toBe(1) // A native retry must not incur another charge after budget expiry.
          expect(money.snapshot()).toMatchObject({ unknownUsage: 1, inFlight: 0, stopped: false })
          expect(money.snapshot().amount).toBeGreaterThan(0)
          expect(tokens.snapshot()).toMatchObject({
            requests: 1,
            input: 200000,
            output: 1000,
            inFlight: 0,
            stopped: false
          })
        },
        { timeoutMs: 100, tokens }
      )
    }
  )

  it('does not reset the whole-request deadline when streaming progress continues', async () => {
    let disconnected = false
    await fixture(
      (_req: any, res: any) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const progress = () =>
          res.write('data: {"choices":[{"delta":{"content":"progress"},"finish_reason":null}]}\n\n')
        progress()
        const timer = setInterval(progress, 20)
        res.once('close', () => {
          clearInterval(timer)
          disconnected = true
        })
      },
      async (gateway) => {
        gateway.beginTurn('finite-whole-request')
        const response = await request(gateway, { stream: true })
        const text = await response.text()
        expect(text).toContain('progress')
        expect(text).toContain('budget-gateway/request-timeout')
        expect(gateway.calls[0]).toMatchObject({ completed: false, retryable: false, errorCode: 'request-timeout' })
        await expect.poll(() => disconnected).toBe(true)
      },
      { timeoutMs: 100 }
    )
  })

  it('does not mistake a stalled retryable HTTP error body for a retryable gateway budget timeout', async () => {
    let disconnected = false
    await fixture(
      (req: any, res: any) => {
        req.resume()
        res.writeHead(503, { 'x-oneapi-request-id': 'stalled-error-body' })
        res.flushHeaders()
        res.once('close', () => (disconnected = true))
      },
      async (gateway, calls) => {
        gateway.beginTurn('stalled-error')
        const response = await request(gateway)
        expect(response.status).toBe(504)
        expect((await response.json()).error).toMatchObject({
          source: 'budget-gateway',
          code: 'request-timeout',
          phase: 'upstream-body',
          request_id: 'stalled-error-body'
        })
        expect(gateway.calls[0]).toMatchObject({ status: 503, errorCode: 'request-timeout', retryable: false })
        await (await request(gateway)).text()
        expect(calls()).toBe(1)
        await expect.poll(() => disconnected).toBe(true)
      },
      { timeoutMs: 100 }
    )
  })

  it('distinguishes an upstream socket interruption after headers from a gateway timeout', async () => {
    await fixture(
      (_req: any, res: any) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-oneapi-request-id': 'socket-7319' })
        res.write('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n')
        const timer = setTimeout(() => res.destroy(), 50)
        res.once('close', () => clearTimeout(timer))
      },
      async (gateway) => {
        gateway.beginTurn('socket-interruption')
        const response = await request(gateway, { stream: true })
        const text = await response.text()
        const payload = JSON.parse(text.trim().split('data: ').at(-1)!)
        expect(payload.error).toMatchObject({
          source: 'upstream',
          code: 'upstream-stream-error',
          phase: 'upstream-body',
          request_id: 'socket-7319'
        })
        expect(gateway.calls[0]).toMatchObject({
          status: 200,
          completed: false,
          retryable: false,
          errorSource: 'upstream',
          errorCode: 'upstream-stream-error',
          errorPhase: 'upstream-body',
          originalError: { name: 'TypeError', cause: { code: 'UND_ERR_SOCKET' } }
        })
        expect(text).not.toContain('request-timeout')
      }
    )
  })

  it('returns a sanitized original upstream HTTP error and the OneAPI request ID', async () => {
    await fixture(
      (_req: any, res: any) =>
        res.writeHead(524, { 'x-oneapi-request-id': 'oneapi-7319' }).end(
          JSON.stringify({
            error: { message: 'provider deadline chosen-secret-only-upstream', code: 'provider_timeout' }
          })
        ),
      async (gateway) => {
        gateway.beginTurn('provider-timeout')
        const response = await request(gateway)
        expect(response.status).toBe(524)
        expect(await response.json()).toMatchObject({
          error: {
            source: 'upstream',
            code: 'upstream-http-error',
            phase: 'upstream-body',
            request_id: 'oneapi-7319',
            originalError: { code: 'provider_timeout' }
          }
        })
        expect(gateway.calls[0]).toMatchObject({ status: 524, requestId: 'oneapi-7319', retryable: true })
        expect(gateway.calls[0].error).toContain('provider deadline [REDACTED]')
        expect(JSON.stringify(gateway.calls)).not.toContain('chosen-secret-only-upstream')
      }
    )
  })

  it.each(['caller', 'client'] as const)(
    'records %s cancellation separately and stops the upstream request',
    async (source) => {
      const controller = new AbortController()
      let upstreamStarted!: () => void
      const started = new Promise<void>((resolve) => (upstreamStarted = resolve))
      let disconnected = false
      await fixture(
        (req: any, res: any) => {
          req.resume()
          res.once('close', () => (disconnected = true))
          upstreamStarted()
        },
        async (gateway, calls) => {
          gateway.beginTurn('cancelled')
          const pending = request(gateway, {}, source === 'client' ? { signal: controller.signal } : {}).catch(
            () => undefined
          )
          await started
          controller.abort()
          const response = await pending
          if (source === 'caller') {
            expect(response).toBeDefined()
            expect((await response!.json()).error).toMatchObject({
              source,
              code: 'cancelled',
              phase: 'upstream-headers'
            })
          }
          await expect.poll(() => gateway.isIdle()).toBe(true)
          await expect.poll(() => disconnected).toBe(true)
          expect(gateway.calls[0]).toMatchObject({ errorSource: source, errorCode: 'cancelled', retryable: false })
          expect(gateway.calls[0].error).not.toContain('request-timeout')
          await (await request(gateway)).text()
          expect(calls()).toBe(1)
        },
        source === 'caller' ? { signal: controller.signal } : {}
      )
    }
  )
})
