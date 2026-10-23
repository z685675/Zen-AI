import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { prepareLivePlan } from '../approval'
import { numberAnswer } from '../configure'
import { liveFixture } from './fixtures'

describe('paid approval binds real artifacts without reading keys', () => {
  it('rejects empty/invalid numeric prices rather than making them free', () => {
    for (const value of ['', ' ', 'NaN', 'Infinity', '-1', '1元']) expect(() => numberAnswer(value)).toThrow()
    expect(numberAnswer('0')).toBe(0)
    expect(numberAnswer('0.075')).toBe(0.075)
  })
  it('changes approval after build, source or question-bank content changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'quality-approval-'))
    try {
      await mkdir(path.join(root, 'out/main'), { recursive: true })
      await mkdir(path.join(root, 'out/renderer'), { recursive: true })
      await writeFile(path.join(root, 'out/main/index.js'), 'synthetic main')
      await writeFile(path.join(root, 'out/renderer/index.html'), '<html>synthetic</html>')
      const revision = { head: 'test', changeDigest: 'source1', base: null, dirty: false, changedPaths: [] }
      const config = liveFixture()
      const first = (await prepareLivePlan(config, root, revision)).plan
      expect(first.executionAvailable).toBe(true)
      const rekeyed = {
        ...config,
        providers: config.providers.map((provider) => ({ ...provider, credentialEnv: 'ZEN_QUALITY_NEW_SESSION_KEY' }))
      }
      expect((await prepareLivePlan(rekeyed, root, revision)).plan.comparisonDigest).toBe(first.comparisonDigest)
      const rerouted = {
        ...config,
        providers: config.providers.map((provider) => ({ ...provider, baseURL: 'https://other-fixture.invalid/v1' }))
      }
      expect((await prepareLivePlan(rerouted, root, revision)).plan.comparisonDigest).not.toBe(first.comparisonDigest)
      const limited = { ...config, budget: { ...config.budget, maxRequests: config.budget.maxRequests + 1 } }
      expect((await prepareLivePlan(limited, root, revision)).plan.comparisonDigest).not.toBe(first.comparisonDigest)
      const resized = { ...config, execution: { ...config.execution, inputSizing: 'estimated-tokens' } }
      const resizedPlan = (await prepareLivePlan(resized, root, revision)).plan
      expect(resizedPlan.approvalDigest).not.toBe(first.approvalDigest)
      expect(resizedPlan.comparisonDigest).not.toBe(first.comparisonDigest)
      await writeFile(path.join(root, 'out/renderer/index.html'), '<html>changed</html>')
      expect((await prepareLivePlan(config, root, revision)).plan.approvalDigest).not.toBe(first.approvalDigest)
      expect(
        (await prepareLivePlan(config, root, { ...revision, changeDigest: 'source2' })).plan.approvalDigest
      ).not.toBe(first.approvalDigest)
      const file = path.join(root, 'prompts.md')
      const prompts = Array.from({ length: 20 }, (_, n) => `### 第${n + 1}轮\n~~~text\n问题${n}\n~~~`).join('\n')
      await writeFile(file, prompts)
      const cost = { ...config, profile: 'cost', execution: { ...config.execution, costPromptFile: file } }
      const before = (await prepareLivePlan(cost, root, revision)).plan.approvalDigest
      await writeFile(file, prompts.replace('问题0', '最新问题0'))
      expect((await prepareLivePlan(cost, root, revision)).plan.approvalDigest).not.toBe(before)
      const missing = await prepareLivePlan(cost, root, { ...revision, head: null })
      expect(missing.plan.executionAvailable).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
