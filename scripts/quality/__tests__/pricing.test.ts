import { describe, expect, it } from 'vitest'

import { amount, costNano, MoneyBudget, planDigest, reserveNano, validatePrice } from '../pricing'

const fixture = () =>
  validatePrice({
    providerRef: 'selected',
    modelId: 'model',
    currency: 'CNY',
    basis: 'key-charge',
    source: 'operator verified selected key group',
    group: 'default',
    capturedAt: '2020-01-01T00:00:00Z',
    validUntil: '2099-01-01T00:00:00Z',
    tiers: [{ throughInputTokens: 200000, input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }]
  })

describe('quality conservative monetary reservations', () => {
  it('charges 130K input including 120K cache once, not 250K input', () => {
    expect(amount(costNano(fixture(), { input: 130000, cacheRead: 120000, cacheWrite: 0, output: 1000 }))).toBeCloseTo(
      0.042
    )
  })
  it('accounts independent cache writes and rejects impossible/unknown usage', () => {
    expect(amount(costNano(fixture(), { input: 100, cacheRead: 20, cacheWrite: 30, output: 0 }))).toBeCloseTo(0.000177)
    expect(() => costNano(fixture(), { input: 1, cacheRead: 2, cacheWrite: 0, output: 0 })).toThrow()
    expect(() => costNano(fixture(), { input: NaN, cacheRead: 0, cacheWrite: 0, output: 0 })).toThrow()
  })
  it('uses worst cache write price, worst applicable tier and preserves tiny amounts', () => {
    const price = fixture()
    price.tiers = [{ ...price.tiers[0], throughInputTokens: 1000, input: 20 }, { ...price.tiers[0] }]
    expect(amount(reserveNano(price, 2000, 100))).toBe(0.041)
    expect(costNano(price, { input: 1, cacheRead: 1, cacheWrite: 0, output: 0 })).toBeGreaterThan(0n)
  })
  it('blocks in-flight oversubscription, counts missing usage, and stops on overrun', () => {
    const money = new MoneyBudget(0.5)
    const id = money.reserve(fixture(), 130000, 1000)
    expect(() => money.reserve(fixture(), 130000, 1000)).toThrow('预算')
    money.settle(id, fixture())
    expect(money.snapshot()).toMatchObject({ unknownUsage: 1, inFlight: 0 })
    expect(() => money.settle(id, fixture())).toThrow()
    const overrun = new MoneyBudget(1)
    const pending = overrun.reserve(fixture(), 1000, 1)
    overrun.settle(pending, fixture(), { input: 20000, output: 1, cacheRead: 0, cacheWrite: 0 })
    expect(overrun.snapshot().stopped).toBe(true)
  })
  it('releases only unsent requests; cancellation blocks future requests', () => {
    const money = new MoneyBudget(1)
    const id = money.reserve(fixture(), 100, 100)
    money.releaseUnsent(id)
    expect(money.snapshot()).toMatchObject({ amount: 0, reserved: 0, unknownUsage: 0 })
    money.stop()
    expect(() => money.reserve(fixture(), 1, 1)).toThrow()
  })
  it('rejects future, expired, unordered, unsupported and unbounded prices', () => {
    expect(() => validatePrice({ ...fixture(), validUntil: '2020-01-02T00:00:00Z' })).toThrow()
    expect(() => validatePrice({ ...fixture(), capturedAt: '2098-01-01T00:00:00Z' })).toThrow()
    expect(() => validatePrice({ ...fixture(), tiers: [fixture().tiers[0], fixture().tiers[0]] })).toThrow()
    expect(() => reserveNano(fixture(), 200001, 0)).toThrow()
    expect(() => validatePrice({ ...fixture(), billingExpr: 'untrusted expression' })).toThrow()
  })
  it('approval hash is key-order stable but changes with model, price or budget', () => {
    expect(planDigest({ a: 1, b: 2 })).toBe(planDigest({ b: 2, a: 1 }))
    expect(planDigest({ model: 'A' })).not.toBe(planDigest({ model: 'B' }))
  })
})
