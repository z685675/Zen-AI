import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'

import { costMarkdown, costSummary } from '../cost'
import { saveEvidence } from '../evidence'
import { checkAnswer, loadCostPrompts, validateJudge } from '../scenarios'

describe('quality independent evidence and cost assertions', () => {
  it('reports unpriced amounts as unknown, including empty batches, without losing inclusive Token statistics', () => {
    const turns = [{ id: 'one', modelId: 'm', providerRef: 'p', entry: 'chat', round: 1 }]
    const call = {
      turnId: 'one',
      amount: null,
      amountBasis: 'unpriced',
      completed: true,
      usageKnown: true,
      usage: { input: 130000, output: 1000, cacheRead: 120000, cacheWrite: 0 }
    } as any
    const summary = costSummary(turns, [call], false)
    expect(summary.groups[0].all).toMatchObject({
      input: 130000,
      output: 1000,
      cacheRead: 120000,
      estimatedAmount: null,
      estimatedPerQuestion: null
    })
    expect(costMarkdown(summary, '未知')).toContain('未核算')
    expect(costMarkdown(summary, '未知')).not.toContain('0.000000000')
    expect(costSummary(turns, [], false).groups[0].all.estimatedAmount).toBeNull()
  })
  it('does not sum cache into total input twice or call API rows user questions', () => {
    const turns = [{ id: 'one', modelId: 'm', providerRef: 'p', entry: 'chat', round: 1 }]
    const call = {
      turnId: 'one',
      amount: 1,
      amountBasis: 'priced-usage',
      completed: true,
      usageKnown: true,
      usage: { input: 130000, output: 1000, cacheRead: 120000, cacheWrite: 0 }
    } as any
    const result = costSummary(turns, [call, call])
    const summary = result.groups[0].all
    expect(summary).toMatchObject({
      userTurns: 1,
      modelCalls: 2,
      input: 260000,
      cacheRead: 240000,
      totalTokensKnown: 262000
    })
    expect(() => costSummary([...turns, ...turns], [])).toThrow()
    expect(costSummary(turns, [{ ...call, usageKnown: false, usage: null }]).groups[0].all.cacheReadRatio).toBeNull()
    const document = costMarkdown(result, 'CNY')
    expect(document).toContain('同一会话累计对比')
    expect(document).toContain('260000')
    expect(document).not.toContain('500000')
  })
  it('requires twenty ordered user prompts and does not send the answer card', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-prompts-'))
    try {
      const file = path.join(directory, 'prompts.md')
      await writeFile(
        file,
        Array.from(
          { length: 20 },
          (_, index) => `### 第${index + 1}轮：问题\n\n~~~text\n普通用户问题${index + 1}\n~~~\n`
        ).join('\n') + '\n## 答案卡\n不要发送这个答案'
      )
      const prompts = await loadCostPrompts(file)
      expect(prompts).toHaveLength(20)
      expect(JSON.stringify(prompts)).not.toContain('不要发送这个答案')
      await writeFile(file, '### 第1轮\n~~~text\n只有一轮\n~~~')
      await expect(loadCostPrompts(file)).rejects.toThrow('20轮')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('checks facts and rejects judge hallucinations/duplicates rather than overriding hard failures', () => {
    expect(checkAnswer('最多3,500元', ['3500'])).toEqual({ nonempty: true, missing: [] })
    expect(
      validateJudge({ facts: [{ id: 'budget', verdict: 'correct', quote: '不存在的证据' }] }, '预算3500', ['budget'])[0]
        .reviewRequired
    ).toBe(true)
    expect(() => validateJudge({ facts: [] }, '预算3500', ['budget'])).toThrow()
  })
  it('exports only whitelisted redacted runner files, never an arbitrary user file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-evidence-'))
    try {
      const report = {
        runId: 'test',
        revisions: {},
        manualRequired: [],
        outcome: 'failed',
        cases: [{ evidence: ['SAFE.log', '../private.log'] }]
      } as any
      await writeFile(path.join(directory, 'SAFE.log'), 'Authorization: Bearer sk-secretsecretsecret\n')
      await writeFile(path.join(directory, 'private.json'), '{"sensitive":"never-export"}')
      await writeFile(path.join(directory, 'report.json'), JSON.stringify({ apiKey: 'hidden' }))
      await mkdir(path.join(directory, 'target-0-assistant'))
      await writeFile(
        path.join(directory, 'target-0-assistant', 'calls.json'),
        JSON.stringify({ apiKey: 'nested-secret', calls: [{ turnId: 'first', usage: { input: 130000 } }] })
      )
      await writeFile(path.join(directory, 'target-0-assistant', 'cookies.json'), '{"session":"never-export"}')
      await saveEvidence(directory, report)
      const zip = new AdmZip(await readFile(path.join(directory, 'failure-evidence.zip')))
      expect(zip.getEntries().map((entry) => entry.entryName)).not.toContain('private.json')
      expect(zip.readAsText('SAFE.log')).not.toContain('secretsecret')
      expect(zip.readAsText('report.json')).not.toContain('hidden')
      expect(zip.readAsText('target-0-assistant/calls.json')).toContain('130000')
      expect(zip.readAsText('target-0-assistant/calls.json')).not.toContain('nested-secret')
      expect(zip.getEntries().map((entry) => entry.entryName)).not.toContain('target-0-assistant/cookies.json')
      expect(zip.readAsText('evidence-manifest.json')).toContain('included')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
