import { describe, expect, it } from 'vitest'

import { planLive } from '../live'
import { matrixScenarios, memoryScenarios, tasksForEntry, tasksForTarget } from '../matrix'
import { checkAnswer } from '../scenarios'
import { liveFixture } from './fixtures'

describe('release/deep expansion is explicit and approval uses the actual denominator', () => {
  it('distributes complete dependent suites across three models without random per-turn switching', () => {
    const scenarios = matrixScenarios({
      profile: 'release',
      modules: ['files', 'history', 'memory'],
      formats: ['docx', 'xlsx', 'json']
    })
    const schedules = [0, 1, 2].map((index) => tasksForTarget(scenarios, 'release', 'assistant', 'mixed', index, 3))
    for (const tasks of schedules) expect(tasks.slice(0, 2).map((task) => task.id)).toEqual(['quick-01', 'quick-02'])
    for (const task of scenarios.filter((item) => !item.id.startsWith('quick-')))
      expect(schedules.flat().filter((item) => item.id === task.id)).toHaveLength(1)
    for (const format of ['docx', 'xlsx'])
      expect(
        schedules
          .find((tasks) => tasks.some((task) => task.id === `read-${format}`))!
          .some((task) => task.id === `create-${format}`)
      ).toBe(true)
    expect(schedules.filter((tasks) => tasks.some((task) => task.kind === 'memory'))).toHaveLength(1)
    for (const [index, tasks] of schedules.entries()) {
      const chat = tasksForTarget(scenarios, 'release', 'chat', 'mixed', index, 3)
      expect(chat.map((task) => task.id)).toEqual(
        tasks.filter((task) => task.kind !== 'file-create').map((task) => task.id)
      )
    }
    const value = liveFixture()
    const targets = [0, 1, 2].map((index) => ({
      ...value.targets[0],
      modelId: `selected-${index}`,
      entries: ['chat', 'assistant']
    }))
    const mixed = {
      ...value,
      profile: 'release',
      allocation: 'mixed',
      modules: ['files', 'history', 'memory'],
      formats: ['docx', 'xlsx', 'json'],
      targets,
      prices: undefined,
      budget: {
        ...value.budget,
        mode: 'tokens',
        acknowledgedUnknownCost: true,
        currency: undefined,
        maxAmount: undefined
      }
    }
    const plan = planLive(mixed)
    expect(plan.executionAvailable).toBe(true)
    expect(plan.userTurns).toBe(plan.assignments.reduce((sum, item) => sum + item.cases.length, 0))
    expect(planLive({ ...mixed, targets: targets.slice(0, 2) }).executionAvailable).toBe(true)
    expect(planLive({ ...mixed, profile: 'cost' }).executionAvailable).toBe(false)
    expect(
      planLive({ ...mixed, targets: [targets[0], { ...targets[1], entries: ['chat'] }, targets[2]] }).executionAvailable
    ).toBe(false)
  })
  it.each([1, 2, 4, 12])(
    'keeps dependent groups complete with %i selected models, with matching plan counts',
    (count) => {
      const scenarios = matrixScenarios({
        profile: 'release',
        modules: ['files', 'history', 'memory'],
        formats: ['json', 'docx']
      })
      const schedules = Array.from({ length: count }, (_, index) =>
        tasksForTarget(scenarios, 'release', 'assistant', 'mixed', index, count)
      )
      for (const task of scenarios.filter((item) => !item.id.startsWith('quick-')))
        expect(schedules.flat().filter((item) => item.id === task.id)).toHaveLength(1)
      for (const tasks of schedules) {
        const memory = tasks.filter((item) => item.kind === 'memory')
        expect([0, 4]).toContain(memory.length)
      }
      const fixture = liveFixture()
      const plan = planLive({
        ...fixture,
        profile: 'release',
        allocation: 'mixed',
        modules: ['files', 'history', 'memory'],
        formats: ['json', 'docx'],
        targets: Array.from({ length: count }, (_, index) => ({
          ...fixture.targets[0],
          modelId: `selected-${index}`,
          entries: ['assistant']
        })),
        prices: undefined,
        budget: {
          ...fixture.budget,
          mode: 'tokens',
          acknowledgedUnknownCost: true,
          currency: undefined,
          maxAmount: undefined
        }
      })
      expect(plan.executionAvailable).toBe(true)
      expect(plan.userTurns).toBe(schedules.flat().length)
    }
  )
  it('does not silently expand unselected modules', () => {
    expect(matrixScenarios({ profile: 'quick', modules: ['files', 'memory'] })).toHaveLength(2)
    expect(matrixScenarios({ profile: 'release', modules: ['history'] }).map((item) => item.id)).toEqual([
      'quick-01',
      'quick-02',
      'history'
    ])
    expect(planLive({ ...liveFixture(), profile: 'release' }).executionAvailable).toBe(false)
  })
  it('counts uploads, actual output tasks and large/corrupt cases separately by entry', () => {
    const scenarios = matrixScenarios({ profile: 'release', modules: ['files'], formats: ['json', 'docx'] })
    expect(tasksForEntry(scenarios, 'release', 'chat')).toHaveLength(6)
    expect(tasksForEntry(scenarios, 'release', 'assistant')).toHaveLength(7)
    const value = liveFixture()
    value.targets[0].entries = ['chat', 'assistant']
    expect(planLive({ ...value, profile: 'release', modules: ['files'], formats: ['json', 'docx'] })).toMatchObject({
      userTurns: 13,
      executionAvailable: true
    })
  })
  it('requires verified vision billing before sending images', () => {
    const config = { ...liveFixture(), profile: 'release', modules: ['files'], formats: ['png'] }
    expect(planLive(config).blockers.some((item) => item.includes('图片'))).toBe(true)
    expect(
      planLive({ ...config, vision: { maxImageTokensPerRequest: 50000, acknowledgedTokenBilling: true } })
        .executionAvailable
    ).toBe(true)
  })
  it('generates bounded deterministic head/middle/tail facts and two corrections', () => {
    const one = memoryScenarios(20000)
    expect(one).toEqual(memoryScenarios(20000))
    expect(one[0].prompt).toContain('MIDDLE4621')
    expect(one[0].prompt.length).toBeGreaterThan(20000)
    expect(one).toHaveLength(4)
    expect(checkAnswer('ZX7319 ZHOU 5500 3500 MIDDLE4621 2026-12-18', one.at(-1)!.required).missing).toEqual([])
    expect(
      checkAnswer('三笔120,230,350；合计700元；预算3,500.00元；2026年12月18日', [
        '120',
        '230',
        '350',
        '700',
        '3500',
        '2026-12-18'
      ]).missing
    ).toEqual([])
    expect(checkAnswer('7000元，2026-11-18', ['700', '2026-12-18']).missing).toHaveLength(2)
    expect(() => memoryScenarios(1000001)).toThrow()
  })
  it('blocks deep without capacity confirmation instead of calling it 200K', () => {
    const config = {
      ...liveFixture(),
      profile: 'deep',
      modules: ['memory'],
      deep: {
        characters: 10000,
        minimumObservedInputTokens: 5000,
        requireCompaction: true,
        acknowledgedApproximateInputSizing: true
      }
    }
    expect(planLive(config).executionAvailable).toBe(false)
    expect(planLive({ ...config, targets: [{ ...config.targets[0], contextWindowTokens: 200000 }] })).toMatchObject({
      userTurns: 6,
      executionAvailable: true
    })
  })
})
