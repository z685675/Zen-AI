import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { loadManifest, parseManifest } from '../manifest'
import { inspectRevision, selectChecks, splitPaths } from '../selection'
import type { Revision } from '../types'

const root = path.resolve(__dirname, '../../..')
const manifestFile = path.join(root, 'tests/quality/manifest.json')
const revision: Revision = { head: 'abc', base: 'def', dirty: true, changedPaths: [], changeDigest: 'digest' }

describe('quality manifest and conservative impact selection', () => {
  it('loads the real catalogue without accepting duplicate or foreign executors', async () => {
    const manifest = await loadManifest(manifestFile)
    expect(manifest.checks.length).toBeGreaterThan(10)
    expect(() => parseManifest({ ...manifest, checks: [manifest.checks[0], manifest.checks[0]] })).toThrow('Duplicate')
    expect(() => parseManifest({ ...manifest, checks: [{ ...manifest.checks[0], project: 'api' }] })).toThrow(
      'Invalid executor'
    )
  })

  it('expands invalid impact maps to full instead of dropping checks', async () => {
    const json = JSON.parse(await readFile(manifestFile, 'utf8'))
    const manifest = parseManifest({ ...json, rules: [{ tags: 'broken' }] })
    const selected = selectChecks(manifest, 'ai', 'changed', revision)
    expect(selected.fallbackToFull).toBe(true)
    expect(selected.checkIds).toContain('AI-UNIT')
  })

  it('does not hide broken check definitions behind the map fallback', async () => {
    const manifest = await loadManifest(manifestFile)
    expect(() => parseManifest({ ...manifest, checks: [{ ...manifest.checks[0], timeoutMs: -1 }] })).toThrow()
  })

  it('expands unknown map tags rather than silently running only static checks', async () => {
    const json = JSON.parse(await readFile(manifestFile, 'utf8'))
    const manifest = parseManifest({ ...json, rules: [{ project: 'ai', prefixes: ['src/'], tags: ['typo'] }] })
    expect(manifest.mappingError).toContain('标签')
    expect(selectChecks(manifest, 'ai', 'changed', revision).checkIds).toContain('AI-UNIT')
  })

  it.each([
    { ...revision, base: null },
    { ...revision, changedPaths: ['new-source/unknown.ts'] },
    { ...revision, changedPaths: ['pnpm-lock.yaml'] },
    { ...revision, changedPaths: ['tsconfig.node.json'] },
    { ...revision, changedPaths: ['packages/shared/IpcChannel.ts'] }
  ])('falls back to full for an unreliable baseline or shared/unknown change', async (changed) => {
    const selected = selectChecks(await loadManifest(manifestFile), 'ai', 'changed', changed)
    expect(selected.fallbackToFull).toBe(true)
    expect(selected.checkIds).toContain('AI-BUILD')
  })

  it('selects policy checks plus static checks, not an unrelated whole test run', async () => {
    const selected = selectChecks(await loadManifest(manifestFile), 'ai', 'changed', {
      ...revision,
      changedPaths: ['src/main/services/ModelAvailabilityService.ts']
    })
    expect(selected.checkIds).toContain('AI-POLICY')
    expect(selected.checkIds).toContain('AI-TYPES')
    expect(selected.checkIds).not.toContain('AI-UNIT')
  })

  it('makes documentation-only scope explicit, and never reduces release checks', async () => {
    const manifest = await loadManifest(manifestFile)
    const docs = { ...revision, changedPaths: ['docs/technical/中文 说明.md'] }
    expect(selectChecks(manifest, 'ai', 'changed', docs).checkIds).toEqual([])
    expect(selectChecks(manifest, 'ai', 'release', docs).checkIds).toContain('AI-UNIT')
  })

  it('parses NUL-delimited paths without splitting spaces or newlines', () => {
    expect(splitPaths('中文 空格.ts\0a\nline.ts\0中文 空格.ts\0')).toEqual(['a\nline.ts', '中文 空格.ts'])
  })

  it('includes staged, unstaged, deleted/renamed and untracked files from a real repository', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-quality-git-'))
    const command = promisify(execFile)
    const git = (args: string[]) => command('git', args, { cwd: directory, windowsHide: true })
    try {
      await git(['init', '-q'])
      await writeFile(path.join(directory, 'before.ts'), 'old')
      await git(['add', '.'])
      await git([
        '-c',
        'user.name=quality-test',
        '-c',
        'user.email=quality-test@example.invalid',
        'commit',
        '-qm',
        'fixture'
      ])
      await git(['mv', 'before.ts', '中文 name.ts'])
      await writeFile(path.join(directory, '中文 name.ts'), 'updated')
      await writeFile(path.join(directory, 'new.ts'), 'untracked')
      const actual = await inspectRevision(directory, 'HEAD')
      expect(actual.error).toBeUndefined()
      expect(actual.changedPaths).toEqual(['before.ts', 'new.ts', '中文 name.ts'])
      expect(actual.dirty).toBe(true)
      const noBase = await inspectRevision(directory)
      expect(noBase.error).toContain('基准')
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})
