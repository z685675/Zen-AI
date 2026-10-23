import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { acceptanceSchema, previewAcceptance, runAcceptance } from '../acceptance'
import { signoff } from '../analysis'
import { auditPackage, packageSnapshot } from '../package-audit'
import { runQuality } from '../run'
import { uiSmoke } from '../ui-smoke'

vi.mock('../selection', () => ({
  inspectRevision: vi.fn(async () => ({
    head: 'fixed',
    changeDigest: 'synthetic',
    dirty: false,
    base: 'fixed',
    changedPaths: []
  }))
}))
vi.mock('../manifest', () => ({
  loadManifest: vi.fn(async () => ({
    manual: [
      {
        id: 'MAN-LOGIN',
        title: '登录',
        tags: ['always'],
        steps: ['手动登录'],
        prompt: '请总结网页。',
        expected: '正确续接',
        reason: '需真实交互'
      }
    ]
  }))
}))
vi.mock('../run', () => ({ runQuality: vi.fn() }))
vi.mock('../ui-smoke', () => ({ uiSmoke: vi.fn() }))
vi.mock('../package-audit', () => ({ auditPackage: vi.fn(), packageSnapshot: vi.fn() }))
afterEach(() => vi.clearAllMocks())

const config = () => ({
  schemaVersion: 1,
  code: 'offline',
  projects: ['ai'],
  ui: true,
  files: false,
  packages: [],
  requiredPlatforms: [],
  requireRealModels: false
})

describe('one release batch, explicit denominator, no accidental paid run', () => {
  it('rejects unknown switches, duplicate platforms and missing approval before executing', async () => {
    expect(() => acceptanceSchema.parse({ ...config(), apiKey: 'not-allowed' })).toThrow()
    await expect(
      previewAcceptance({ ...config(), requiredPlatforms: ['mac/arm64', 'mac/arm64'] }, '.')
    ).rejects.toThrow('重复')
    await expect(runAcceptance(config(), '.', { dryRun: false })).rejects.toThrow('摘要')
    expect(runQuality).not.toHaveBeenCalled()
  })
  it('preview does not launch product or read credentials, retains missing platforms/live in the plan', async () => {
    const plan = await previewAcceptance(
      { ...config(), requiredPlatforms: ['mac/arm64'], requireRealModels: true },
      '.'
    )
    expect(plan.phases.map((phase) => phase.id)).toEqual(['CODE', 'UI', 'MISSING-mac-arm64', 'LIVE'])
    expect(plan.paidCallsInPreview).toBe(0)
    expect(runQuality).not.toHaveBeenCalled()
    expect(uiSmoke).not.toHaveBeenCalled()
  })
  it('reuses only a complete passing code report for the same revision and profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'quality-acceptance-reuse-'))
    try {
      const prior = {
        schemaVersion: 1,
        mode: 'offline',
        outcome: 'passed',
        dryRun: false,
        finishedAt: new Date().toISOString(),
        cases: [{ id: 'CODE-TEST', status: 'passed' }],
        revisions: { ai: { head: 'fixed', changeDigest: 'synthetic' } }
      }
      const file = path.join(root, 'code-report.json')
      await writeFile(file, JSON.stringify(prior))
      const value = { ...config(), codeReport: file }
      const plan = await previewAcceptance(value, root)
      const result = await runAcceptance(value, root, { dryRun: false, approval: plan.approvalDigest })
      expect(result.report.outcome).toBe('passed')
      expect(runQuality).not.toHaveBeenCalled()
      expect(result.report.cases[0].detail).toContain('没有重复全量测试')
      for (const override of [
        { mode: 'release' },
        { outcome: 'failed' },
        { dryRun: true },
        { cases: [] },
        { cases: [{ id: 'CODE-TEST', status: 'not_run' }] },
        { revisions: { ai: { head: 'other', changeDigest: 'synthetic' } } },
        { revisions: { ai: { head: 'fixed', changeDigest: 'different' } } }
      ]) {
        await writeFile(file, JSON.stringify({ ...prior, ...override }))
        await expect(previewAcceptance(value, root)).rejects.toThrow()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('a failed code gate leaves UI unrun; human attestation cannot override automatic failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'quality-acceptance-fail-'))
    try {
      const value = config()
      const plan = await previewAcceptance(value, root)
      vi.mocked(runQuality).mockResolvedValue({
        directory: path.join(root, 'child'),
        report: { outcome: 'failed' }
      } as any)
      const result = await runAcceptance(value, root, { dryRun: false, approval: plan.approvalDigest })
      expect(result.report.outcome).toBe('failed')
      expect(result.report.cases[1].status).toBe('not_run')
      expect(uiSmoke).not.toHaveBeenCalled()
      const receipt = JSON.parse(await readFile(path.join(result.directory, 'manual-results.template.json'), 'utf8'))
      receipt.results[0].status = 'passed'
      const file = path.join(root, 'receipt.json')
      await writeFile(file, JSON.stringify(receipt))
      expect((await signoff(result.directory, file)).releaseReady).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('rejects a package swapped after approval before executing its native binaries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'quality-acceptance-package-'))
    try {
      const value = {
        ...config(),
        ui: false,
        packages: [{ resources: 'fixture', platform: 'windows', arch: 'x64', expectedVersion: '1.1.73' }]
      }
      const snapshot = { archiveSha256: 'old', runtimeSha256: 'old-native' } as any
      vi.mocked(packageSnapshot).mockResolvedValue(snapshot)
      const plan = await previewAcceptance(value, root)
      vi.mocked(runQuality).mockImplementationOnce(async () => {
        vi.mocked(packageSnapshot).mockResolvedValue({ ...snapshot, runtimeSha256: 'replaced-native' })
        return { directory: path.join(root, 'child'), report: { outcome: 'passed' } } as any
      })
      const result = await runAcceptance(value, root, { dryRun: false, approval: plan.approvalDigest })
      expect(result.report.outcome).toBe('failed')
      expect(result.report.cases[1].detail).toContain('批准后安装包或内核被替换')
      expect(auditPackage).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('successful automatic phases generate manual checklist and require matching run/source to sign off', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'quality-acceptance-pass-'))
    try {
      const value = config(),
        plan = await previewAcceptance(value, root)
      vi.mocked(runQuality).mockResolvedValue({
        directory: path.join(root, 'child'),
        report: { outcome: 'passed' }
      } as any)
      const result = await runAcceptance(value, root, { dryRun: false, approval: plan.approvalDigest })
      expect(result.exitCode).toBe(0)
      expect(uiSmoke).toHaveBeenCalledTimes(1)
      expect(await readFile(path.join(result.directory, 'manual-checks.md'), 'utf8')).toContain('请总结网页')
      const receipt = JSON.parse(await readFile(path.join(result.directory, 'manual-results.template.json'), 'utf8'))
      receipt.results[0].status = 'passed'
      const file = path.join(root, 'receipt.json')
      await writeFile(file, JSON.stringify(receipt))
      expect((await signoff(result.directory, file)).releaseReady).toBe(true)
      await writeFile(file, JSON.stringify({ ...receipt, sourceDigest: 'different' }))
      await expect(signoff(result.directory, file)).rejects.toThrow('同一次')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
