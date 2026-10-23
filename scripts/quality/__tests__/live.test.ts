import { describe, expect, it } from 'vitest'

import { fileTestContextWindow, liveConfigSchema, planLive, RequestBudget } from '../live'
import { liveFixture } from './fixtures'

const config = {
  schemaVersion: 1,
  profile: 'quick',
  targets: ['gpt', 'claude', 'gemini', 'grok'].map((family) => ({
    family,
    providerRef: 'selected-provider',
    modelId: `${family}-selected-model`,
    entries: ['chat', 'assistant']
  })),
  budget: {
    currency: 'CNY',
    maxAmount: 5,
    maxRequests: 80,
    maxOutputTokensPerRequest: 1000,
    maxInputTokens: 500000,
    maxOutputTokens: 20000,
    timeoutMs: 600000
  }
}

describe('quality paid plan is explicit and fail closed', () => {
  it('declares a bounded chat file-test window without raising approved paid limits or shrinking attachments', () => {
    const fixture = liveFixture()
    const config = liveConfigSchema.parse({
      ...fixture,
      profile: 'release',
      modules: ['files'],
      formats: ['docx'],
      prices: undefined,
      execution: { ...fixture.execution, maxInputTokensPerRequest: 128000, inputSizing: 'estimated-tokens' },
      budget: {
        ...fixture.budget,
        mode: 'tokens',
        acknowledgedUnknownCost: true,
        currency: undefined,
        maxAmount: undefined,
        maxOutputTokensPerRequest: 8192
      }
    })
    const target = config.targets[0]
    expect(fileTestContextWindow(config, target, 'chat')).toBe(70144)
    expect(fileTestContextWindow(config, target, 'assistant')).toBeUndefined()
    expect(fileTestContextWindow(config, { ...target, contextWindowTokens: 32000 }, 'chat')).toBe(32000)
    expect(fileTestContextWindow({ ...config, profile: 'cost' }, target, 'chat')).toBeUndefined()
    expect(fileTestContextWindow({ ...config, profile: 'deep' }, target, 'chat')).toBeUndefined()
    expect(
      fileTestContextWindow({ ...config, execution: { ...config.execution!, inputSizing: undefined } }, target, 'chat')
    ).toBeUndefined()
    expect(
      fileTestContextWindow(
        { ...config, vision: { maxImageTokensPerRequest: 8192, acknowledgedTokenBilling: true } },
        target,
        'chat'
      )
    ).toBe(66048)
    const plan = planLive(config)
    expect(plan.assignments[0].contextWindowTokens).toBe(70144)
    expect(plan.budget.maxInputTokens).toBe(fixture.budget.maxInputTokens)
    expect(plan.budget.maxRequests).toBe(fixture.budget.maxRequests)
    expect(plan.executionAvailable).toBe(true)
    expect(plan.assignments[0].cases).toContain('read-multiple-large')
    expect(plan.limitations.join('')).toContain('不代表已验证模型200K真实容量')
  })
  it('binds input preflight strategy and never silently relaxes old or money configurations', () => {
    const value = liveFixture()
    const strict = planLive(value)
    expect(strict.inputSizing).toBe('utf8-bytes')
    const execution = { ...value.execution, inputSizing: 'estimated-tokens' }
    const money = planLive({ ...value, execution })
    expect(money.executionAvailable).toBe(false)
    expect(money.blockers.join('')).toContain('money模式')
    const estimate = planLive({
      ...value,
      execution,
      prices: undefined,
      budget: {
        ...value.budget,
        mode: 'tokens',
        acknowledgedUnknownCost: true,
        currency: undefined,
        maxAmount: undefined
      }
    })
    expect(estimate).toMatchObject({ executionAvailable: true, inputSizing: 'estimated-tokens' })
    expect(estimate.limitations.join('')).toContain('×2安全余量')
    expect(estimate.limitations.join('')).toContain('不是精确Tokenizer')
    expect(estimate.approvalDigest).not.toBe(strict.approvalDigest)
  })
  it('permits an explicitly acknowledged token-limited batch without any currency or prices', () => {
    const value = liveFixture()
    const budget = {
      ...value.budget,
      mode: 'tokens',
      acknowledgedUnknownCost: true,
      currency: undefined,
      maxAmount: undefined
    }
    const selected = { ...value, prices: undefined, budget }
    expect(planLive(selected)).toMatchObject({
      executionAvailable: true,
      estimates: [],
      conservativeBatchMaximum: null
    })
    expect(
      planLive({ ...selected, budget: { ...budget, acknowledgedUnknownCost: undefined } }).executionAvailable
    ).toBe(false)
    expect(planLive({ ...selected, budget: { ...budget, maxAmount: 10 } }).executionAvailable).toBe(false)
    expect(planLive({ ...selected, prices: value.prices }).executionAvailable).toBe(false)
    expect(planLive({ ...value, prices: undefined }).executionAvailable).toBe(false)
    expect(planLive({ ...value, budget: { ...value.budget, maxAmount: undefined } }).executionAvailable).toBe(false)
  })
  it('plans twenty quick user messages or 160 cost messages, never API log rows as questions', () => {
    expect(planLive(config)).toMatchObject({ userTurns: 20, executionAvailable: false })
    expect(planLive({ ...config, profile: 'cost' }).userTurns).toBe(160)
    expect(planLive({ ...config, profile: 'deep' }).executionAvailable).toBe(false)
  })

  it('refuses raw keys, missing budgets, duplicated targets and unknown model families', () => {
    expect(() => planLive({ ...config, apiKey: 'secret' })).toThrow()
    expect(() => planLive({ ...config, budget: undefined })).toThrow()
    expect(() => planLive({ ...config, targets: [config.targets[0], config.targets[0]] })).toThrow('重复')
    expect(() => planLive({ ...config, targets: [{ ...config.targets[0], family: 'invented' }] })).toThrow()
  })
})

describe('quality request and token reservation ledger', () => {
  it('reserves in-flight usage atomically and rejects oversubscription', () => {
    const budget = new RequestBudget({ maxRequests: 5, maxInputTokens: 100, maxOutputTokens: 30 })
    const one = budget.reserve(80, 10)
    expect(() => budget.reserve(21, 1)).toThrow('exhausted')
    budget.settle(one, { input: 60, output: 5 })
    expect(() => budget.reserve(40, 25)).not.toThrow()
    expect(budget.snapshot().requests).toBe(2)
    expect(() => budget.settle(one)).toThrow('already')
  })

  it('does not refund requests and counts unknown/failing usage at reserved maximum', () => {
    const budget = new RequestBudget({ maxRequests: 1, maxInputTokens: 100, maxOutputTokens: 30 })
    const one = budget.reserve(50, 15)
    budget.settle(one)
    expect(budget.snapshot()).toMatchObject({ requests: 1, input: 50, output: 15 })
    expect(() => budget.reserve(1, 1)).toThrow()
  })

  it('stops after cancellation or unexpectedly higher actual usage', () => {
    const budget = new RequestBudget({ maxRequests: 10, maxInputTokens: 100, maxOutputTokens: 30 })
    const one = budget.reserve(50, 15)
    budget.settle(one, { input: 200, output: 5 })
    expect(() => budget.reserve(0, 0)).toThrow()
    const cancelled = new RequestBudget({ maxRequests: 1, maxInputTokens: 1, maxOutputTokens: 1 })
    cancelled.stop()
    expect(() => cancelled.reserve(0, 0)).toThrow()
  })

  it('refuses negative, fractional or infinite limits/reservations', () => {
    expect(() => new RequestBudget({ maxRequests: Infinity, maxInputTokens: 1, maxOutputTokens: 1 })).toThrow()
    const budget = new RequestBudget({ maxRequests: 1, maxInputTokens: 1, maxOutputTokens: 1 })
    expect(() => budget.reserve(-1, 0)).toThrow()
    expect(() => budget.reserve(0, 0.1)).toThrow()
  })
})
