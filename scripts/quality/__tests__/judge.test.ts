import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, it } from 'vitest'

import { listenOnLoopback } from '../../../packages/shared/utils/loopbackServer'
import { runJudge } from '../judge'
import { RequestBudget } from '../live'
import { MoneyBudget, validatePrice } from '../pricing'

async function fixture(mode: 'valid' | 'bad-calibration' | 'fake-quote', maxAmount = 1) {
  const requests: any[] = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(request)
    const sample = JSON.parse(request.messages[1].content)
    const verdict = sample.id.endsWith('incorrect')
      ? 'incorrect'
      : sample.id.endsWith('uncertain')
        ? 'uncertain'
        : 'correct'
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                facts: [
                  {
                    id: sample.facts[0].id,
                    verdict: mode === 'bad-calibration' ? 'correct' : verdict,
                    quote: mode === 'fake-quote' ? 'made up quotation' : sample.answer
                  }
                ]
              })
            }
          }
        ],
        usage: { prompt_tokens: 200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } }
      })
    )
  })
  await listenOnLoopback(server)
  const money = new MoneyBudget(1)
  try {
    const result = await runJudge({
      modelId: 'judge',
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      credential: 'cost-free-local-fixture',
      price: validatePrice({
        providerRef: 'local',
        modelId: 'judge',
        currency: 'CNY',
        basis: 'key-charge',
        source: 'synthetic price',
        group: 'test',
        capturedAt: '2020-01-01T00:00:00Z',
        validUntil: '2099-01-01T00:00:00Z',
        tiers: [{ throughInputTokens: 20000, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 }]
      }),
      money,
      tokens: new RequestBudget({ maxRequests: 10, maxInputTokens: 200000, maxOutputTokens: 10000 }),
      maxRequests: 4,
      maxAmount,
      maxInput: 16000,
      samples: [
        { id: 'memory', question: '预算？', answer: '可用3500元。', facts: [{ id: 'budget', expected: '可用3500元' }] }
      ]
    })
    return { result, requests, money: money.snapshot() }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('optional judge is calibrated, bounded, separately charged and never executes tools', () => {
  it('checks labelled good/bad/uncertain before evaluating an answer', async () => {
    const { result, requests, money } = await fixture('valid')
    expect(result).toMatchObject({ calibrated: true, verdict: 'passed' })
    expect(requests).toHaveLength(4)
    expect(requests.every((request) => !request.tools && request.max_tokens === 1000)).toBe(true)
    expect(result.cost).toBeGreaterThan(0)
    expect(money.amount).toBe(result.cost)
  })
  it('does not trust an always-correct judge or invented evidence', async () => {
    expect((await fixture('bad-calibration')).result).toMatchObject({ calibrated: false, verdict: 'review-required' })
    expect((await fixture('fake-quote')).result).toMatchObject({ calibrated: false, verdict: 'review-required' })
  })
  it('stops before sending when the explicit judge sub-budget cannot reserve one request', async () => {
    const { result, requests } = await fixture('valid', 0.000001)
    expect(result.verdict).toBe('review-required')
    expect(requests).toHaveLength(0)
  })
})
