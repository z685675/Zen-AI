import { describe, expect, it } from 'vitest'

import { compareCosts, parseCSV, reconcileCalls } from '../analysis'

describe('billing reconciliation never joins by approximate time', () => {
  it('parses Chinese/BOM, quoted comma, escaped quotes and newlines', () => {
    expect(parseCSV('\uFEFF请求ID,备注\r\nabc,"first,""second""\nthird"\r\n')).toEqual([
      { 请求ID: 'abc', 备注: 'first,"second"\nthird' }
    ])
    for (const value of ['a,a\n1,2', 'a,b\n"unfinished', 'a,b\n1', 'a\n"x"z']) expect(() => parseCSV(value)).toThrow()
  })
  const call = {
    sequence: 1,
    requestId: 'abc',
    usage: { input: 130000, output: 100, cacheRead: 120000, cacheWrite: 0 },
    amount: 1,
    amountBasis: 'priced-usage'
  } as any
  const row = {
    请求ID: 'abc',
    '输入Token（含缓存）': '130000',
    输出Token: '100',
    '缓存Token（输入子集）': '120000',
    '净扣费（USD）': '1.1'
  }
  it('matches exact request ID and keeps input inclusive of cache', () => {
    expect(reconcileCalls([call], [row, { ...row, 请求ID: 'unrelated' }], 'USD')).toMatchObject({
      status: 'matched',
      unrelatedRowsIgnored: 1,
      matches: [{ status: 'matched', server: { input: 130000, cache: 120000 } }]
    })
    expect(reconcileCalls([{ ...call, requestId: undefined }], [row], 'USD').status).toBe('usage_pending')
    expect(reconcileCalls([call], [row, row], 'USD').matches[0].status).toBe('ambiguous')
    expect(reconcileCalls([call], [{ ...row, 输出Token: '9' }], 'CNY').status).toBe('mismatch')
    expect(reconcileCalls([call], [row], 'CNY').matches[0]).toMatchObject({ difference: null })
  })
  it('refuses changed prices/models and does not compare incomplete or failed runs', () => {
    const summary = {
      groups: [
        {
          providerRef: 'p',
          modelId: 'm',
          entry: 'chat',
          all: { completedUserTurns: 20, plannedUserTurns: 20, missingUsage: 0, failedCalls: 0, estimatedAmount: 1 }
        }
      ]
    }
    expect(() => compareCosts(summary, summary, { comparisonDigest: 'a' }, { comparisonDigest: 'b' })).toThrow('不一致')
    expect(() => compareCosts(summary, summary, {}, {})).toThrow('快照')
    expect(compareCosts(summary, summary, { comparisonDigest: 'same' }, { comparisonDigest: 'same' })[0].status).toBe(
      'observational-only'
    )
    expect(
      compareCosts(summary, { groups: [] }, { comparisonDigest: 'same' }, { comparisonDigest: 'same' })[0].status
    ).toBe('incomplete-not-comparable')
    const unknown = { groups: [{ ...summary.groups[0], all: { ...summary.groups[0].all, estimatedAmount: null } }] }
    expect(compareCosts(unknown, unknown, { comparisonDigest: 'same' }, { comparisonDigest: 'same' })[0].status).toBe(
      'incomplete-not-comparable'
    )
  })
  it('compares known tokens and cache in unpriced experiments while leaving money unknown', () => {
    const group = {
      providerRef: 'p',
      modelId: 'm',
      entry: 'chat',
      all: {
        completedUserTurns: 20,
        plannedUserTurns: 20,
        missingUsage: 0,
        failedCalls: 0,
        estimatedAmount: null,
        input: 10000,
        output: 1000,
        cacheRead: 8000,
        modelCalls: 20,
        cacheReadRatio: 0.8
      }
    }
    const plan = { comparisonDigest: 'same', budget: { mode: 'tokens' } }
    const before = { groups: [group] }
    const after = { groups: [{ ...group, all: { ...group.all, input: 9000, cacheRead: 7000 } }] }
    expect(compareCosts(before, after, plan, plan)[0]).toMatchObject({
      status: 'observational-usage-only',
      cost: 'unknown',
      delta: null,
      usage: { input: { before: 10000, after: 9000, delta: -1000 }, cacheRead: { delta: -1000 } }
    })
    for (const change of [{ completedUserTurns: 19 }, { missingUsage: 1 }, { failedCalls: 1 }, { input: undefined }])
      expect(
        compareCosts(before, { groups: [{ ...group, all: { ...group.all, ...change } }] }, plan, plan)[0].status
      ).toBe('incomplete-not-comparable')
  })
})
