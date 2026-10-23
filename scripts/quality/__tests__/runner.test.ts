import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import * as commands from '../commands'
import { execute, offlineEnvironment, redact, sanitizeEvidence } from '../process'
import { renderReport, reportExitCode, saveReport, summarize } from '../report'
import { parseGo, parseNativeSmoke, parseVitest } from '../results'
import { parseArgs, runCheck, runQuality } from '../run'
import type { QualityReport } from '../types'

function report(): QualityReport {
  return {
    schemaVersion: 1,
    runId: 'fixture',
    mode: 'offline',
    dryRun: false,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version, packaged: false },
    network: { paidCallsAuthorized: false, credentialsInherited: false, osSandbox: false },
    revisions: {},
    inventory: [],
    selection: [],
    cases: [],
    summary: {
      planned: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      not_run: 0,
      environment_blocked: 0,
      review_required: 0,
      cancelled: 0
    },
    manualRequired: [],
    limitations: [],
    outcome: 'incomplete'
  }
}

const jsonResult = (overrides: object = {}) =>
  JSON.stringify({
    success: true,
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 1,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    testResults: [
      {
        name: 'fixture.test.ts',
        status: 'passed',
        assertionResults: [
          { fullName: 'one', status: 'passed' },
          { fullName: 'two', status: 'skipped' }
        ]
      }
    ],
    ...overrides
  })

afterEach(() => vi.restoreAllMocks())

describe('quality trustworthy results', () => {
  it('shows non-blocking naming warnings without counting a main-answer failure or hiding a real failure', () => {
    const current = report()
    current.cases.push({
      id: 'one',
      project: 'ai',
      title: '主回答',
      status: 'passed',
      durationMs: 10,
      evidence: [],
      warnings: ['自动命名失败；保留本地标题。']
    })
    expect(summarize(current).outcome).toBe('passed')
    expect(current.summary).toMatchObject({ passed: 1, failed: 0 })
    expect(renderReport(current)).toContain('通过（有警告）')
    expect(renderReport(current)).toContain('## 非阻断警告')
    expect(renderReport(current)).toContain('one：自动命名失败')
    current.cases[0].status = 'failed'
    expect(reportExitCode(summarize(current))).toBe(1)
  })
  it('keeps skipped assertions separate and rejects zero/malformed or failed runtimes', () => {
    expect(parseVitest(jsonResult()).tests).toEqual({ passed: 1, failed: 0, skipped: 1, pending: 0 })
    expect(parseVitest(jsonResult({ success: false })).successful).toBe(false)
    expect(() => parseVitest(jsonResult({ numTotalTests: 0 }))).toThrow()
    expect(() => parseVitest(jsonResult({ numTotalTests: 3 }))).toThrow()
    expect(() => parseVitest('not json')).toThrow()
    expect(() => parseVitest(jsonResult({ numPassedTests: 2, numPendingTests: 0 }))).toThrow('逐项状态')
    const pending = JSON.parse(jsonResult())
    pending.testResults[0].assertionResults[1].status = 'pending'
    expect(parseVitest(JSON.stringify(pending))).toMatchObject({ successful: false, tests: { skipped: 0, pending: 1 } })
  })

  it('requires structured Go outcomes and rejects partial, non-JSON or duplicate results', () => {
    const lines = [
      { Action: 'pass', Package: 'fixture', Test: 'TestOne' },
      { Action: 'skip', Package: 'fixture', Test: 'TestTwo' },
      { Action: 'pass', Package: 'fixture' }
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')
    expect(parseGo(lines)).toEqual({ successful: true, tests: { passed: 1, failed: 0, skipped: 1, pending: 0 } })
    expect(() => parseGo('ok\tfixture')).toThrow()
    expect(() =>
      parseGo(lines + '\n' + JSON.stringify({ Action: 'pass', Package: 'fixture', Test: 'TestOne' }))
    ).toThrow('重复')
    expect(() => parseGo(JSON.stringify({ Action: 'start', Package: 'fixture' }))).toThrow('完整')
    expect(() =>
      parseGo(lines + '\n' + JSON.stringify({ Action: 'run', Package: 'fixture', Test: 'TestHung' }))
    ).toThrow('终态')
    expect(() => parseGo(JSON.stringify({ Action: 'pass', Package: 'fixture', Test: 'TestOne' }))).toThrow('完整')
  })

  it('requires final native smoke evidence and every attachment scenario', () => {
    expect(parseNativeSmoke('PASS OpenCode 1.18.35: native tools, zero paid requests', false).successful).toBe(true)
    expect(() => parseNativeSmoke('starting native smoke', false)).toThrow('证据')
    const names = [
      'oversized PNG file URL',
      'oversized JPEG data URL',
      'multi-file PNG + JPEG + text',
      'native 9.9MB PDF read and large event',
      'product client consumes native large PDF event',
      'native compaction strips base64 and retains recent turns / paths',
      'failed native compaction never reports success / hides history',
      'empty native compaction is discarded without losing original context',
      'loopback mock / native still healthy'
    ]
    const data = {
      version: '1.18.35',
      paidRequests: 0,
      mockRequests: 10,
      results: names.map((name) => ({ name, status: 'PASS' }))
    }
    const output = (value: unknown) => `prefix\nRESULT ${JSON.stringify(value)}\n`
    expect(parseNativeSmoke(output(data), true).tests.passed).toBe(9)
    expect(() => parseNativeSmoke(output({ ...data, results: data.results.slice(1) }), true)).toThrow('缺失')
    expect(() => parseNativeSmoke(output({ ...data, results: [...data.results, data.results[0]] }), true)).toThrow(
      '重复'
    )
    expect(() => parseNativeSmoke(output({ ...data, paidRequests: 1 }), true)).toThrow()
    expect(() => parseNativeSmoke(output(data) + output(data), true)).toThrow('唯一')
    expect(
      parseNativeSmoke(output({ ...data, results: data.results.map((item) => ({ ...item, status: 'FAIL' })) }), true)
        .successful
    ).toBe(false)
  })

  it('does not turn no execution, missing project, cancellation, or zero tests into green', () => {
    expect(reportExitCode(summarize(report()))).toBe(2)
    for (const status of ['not_run', 'environment_blocked', 'cancelled', 'failed'] as const) {
      const current = report()
      current.cases = [{ id: 'A', project: 'ai', title: 'fixture', status, durationMs: 0, evidence: [] }]
      expect(reportExitCode(summarize(current))).not.toBe(0)
    }
    const planned = report()
    planned.dryRun = true
    expect(summarize(planned).outcome).toBe('planned')
    const unfinished = report()
    unfinished.finishedAt = null
    unfinished.cases = [{ id: 'A', project: 'ai', title: 'fixture', status: 'passed', durationMs: 0, evidence: [] }]
    expect(summarize(unfinished).outcome).toBe('incomplete')
  })

  it('does not hide manifest/configuration failures behind a successful dry-run or inventory', () => {
    for (const mode of ['inventory', 'live'] as const) {
      const current = report()
      current.mode = mode
      current.dryRun = true
      current.cases = [
        { id: 'QUALITY-RUNNER', project: 'ai', title: 'invalid config', status: 'failed', durationMs: 0, evidence: [] }
      ]
      expect(reportExitCode(summarize(current))).toBe(1)
    }
  })

  it('does not leak credentials or break JSON while sanitizing', async () => {
    const secret = 'sk-ThisIsATestSecret123'
    const value = {
      apiKey: secret,
      nested: ['Bearer test-secret', { password: 'private' }],
      text: 'https://example.invalid/?key=test-secret'
    }
    expect(JSON.stringify(sanitizeEvidence(value))).not.toContain(secret)
    expect(redact('Authorization: Bearer test-secret\npassword="private"')).not.toContain('private')
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-quality-report-'))
    try {
      const current = report()
      current.limitations.push(`Bearer ${secret}`)
      await saveReport(directory, current)
      const text = await readFile(path.join(directory, 'report.json'), 'utf8')
      expect(JSON.parse(text).schemaVersion).toBe(1)
      expect(text).not.toContain(secret)
      expect(await readFile(path.join(directory, 'report.md'), 'utf8')).toContain('没有执行检查')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps paid credentials, proxy overrides and preloads out of offline children', () => {
    const env = offlineEnvironment({
      PATH: '/bin',
      SystemRoot: 'C:/Windows',
      OPENAI_API_KEY: 'secret',
      SQL_DSN: 'production',
      HTTP_PROXY: 'secret',
      NODE_OPTIONS: '--require=spy',
      npm_execpath: 'private'
    })
    expect(env.PATH).toBe('/bin')
    expect(env.SystemRoot).toBe('C:/Windows')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.SQL_DSN).toBeUndefined()
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
  })

  it('rejects unknown/duplicated CLI flags and does not accept a live config in offline mode', () => {
    expect(() => parseArgs(['offline', '--mystery'])).toThrow()
    expect(() => parseArgs(['offline', '--dry-run', '--dry-run'])).toThrow('重复')
    expect(() => parseArgs(['offline', '--config', 'private.json'])).toThrow('仅用于')
    expect(parseArgs(['changed', '--project', 'api', '--api-base', 'HEAD']).projects).toEqual(['api'])
  })

  it('writes a failed report even when the project/manifest is unavailable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-quality-fail-'))
    try {
      const result = await runQuality({ mode: 'offline', projects: ['ai'], dryRun: false }, directory)
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(await readFile(path.join(result.directory, 'report.json'), 'utf8')).outcome).toBe('failed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a green assertion report followed by a failing native process', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-quality-native-exit-'))
    try {
      vi.spyOn(commands, 'buildCommand').mockImplementation(async (_check, _root, artifact) => ({
        file: process.execPath,
        args: [
          '-e',
          'require("node:fs").writeFileSync(process.argv[1],process.argv[2]);process.exitCode=7',
          artifact,
          jsonResult()
        ],
        cwd: directory
      }))
      const result = await runCheck(
        {
          id: 'FIXTURE',
          project: 'ai',
          title: 'native exit',
          executor: 'vitest',
          target: [],
          modes: ['offline'],
          tags: ['quality'],
          timeoutMs: 5000
        },
        directory,
        directory
      )
      expect(result.tests?.passed).toBe(1)
      expect(result.status).toBe('failed')
      expect(result.exitCode).toBe(7)
      expect(result.detail).toContain('断言通过也不算')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sanitizes malformed or invalid evidence even when validation fails', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-quality-invalid-evidence-'))
    try {
      for (const text of ['Bearer secret-private not-json', '{"apiKey":"private","success":true}']) {
        vi.spyOn(commands, 'buildCommand').mockImplementation(async (_check, _root, artifact) => ({
          file: process.execPath,
          args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],process.argv[2])', artifact, text],
          cwd: directory
        }))
        const result = await runCheck(
          {
            id: 'FIXTURE',
            project: 'ai',
            title: 'invalid',
            executor: 'vitest',
            target: [],
            modes: ['offline'],
            tags: ['quality'],
            timeoutMs: 5000
          },
          directory,
          directory
        )
        expect(result.status).toBe('failed')
        const sanitized = await readFile(path.join(directory, 'FIXTURE.tests.json'), 'utf8')
        expect(() => JSON.parse(sanitized)).not.toThrow()
        expect(sanitized).not.toContain('private')
        vi.restoreAllMocks()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('blocks a green run if project source changes while checks are running', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-quality-revision-'))
    const command = promisify(execFile)
    const git = (args: string[]) => command('git', args, { cwd: directory, windowsHide: true })
    try {
      await mkdir(path.join(directory, 'tests/quality'), { recursive: true })
      await writeFile(path.join(directory, 'package.json'), '{"scripts":{}}')
      await writeFile(path.join(directory, '.gitignore'), 'local/\n')
      await writeFile(path.join(directory, 'project.txt'), 'before')
      await writeFile(
        path.join(directory, 'tests/quality/manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          checks: [
            {
              id: 'FIXTURE',
              project: 'ai',
              title: 'fixture',
              executor: 'script',
              target: ['test:lint'],
              modes: ['offline'],
              tags: ['quality'],
              timeoutMs: 5000
            }
          ],
          rules: [],
          manual: []
        })
      )
      await git(['init', '-q'])
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
      vi.spyOn(commands, 'buildCommand').mockResolvedValue({
        file: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync("project.txt","changed")'],
        cwd: directory
      })
      const result = await runQuality({ mode: 'offline', projects: ['ai'], dryRun: false }, directory)
      expect(result.exitCode).toBe(2)
      expect(result.report.cases.find((item) => item.id === 'FIXTURE')?.status).toBe('passed')
      expect(result.report.cases.find((item) => item.id === 'QUALITY-REVISION-AI')?.status).toBe('environment_blocked')
      expect(result.report.revisions.ai?.changeDigest).not.toBe(result.report.finalRevisions?.ai?.changeDigest)
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('does not let a test filter inject update flags or escape the project', async () => {
    for (const target of ['--update', '../outside.test.ts']) {
      await expect(
        commands.buildCommand(
          {
            id: 'FIXTURE',
            project: 'ai',
            title: 'fixture',
            executor: 'vitest',
            target: [target],
            modes: ['offline'],
            tags: ['quality'],
            timeoutMs: 5000
          },
          process.cwd(),
          'unused'
        )
      ).rejects.toThrow('项目内测试路径')
    }
  })

  it('does not ignore a stale test path alongside valid filters', async () => {
    await expect(
      commands.buildCommand(
        {
          id: 'FIXTURE',
          project: 'ai',
          title: 'fixture',
          executor: 'vitest',
          target: ['scripts/quality', 'scripts/quality/nonexistent.test.ts'],
          modes: ['offline'],
          tags: ['quality'],
          timeoutMs: 5000
        },
        path.resolve(__dirname, '../../..'),
        'unused'
      )
    ).rejects.toThrow('测试路径不存在')
  })
})

describe('quality process execution', () => {
  const node = (source: string) => ({ file: process.execPath, args: ['-e', source], cwd: process.cwd() })

  it('captures Unicode output without a shell and preserves failed exit codes', async () => {
    const actual = await execute(node('process.stdout.write("中文 路径"); process.exitCode=7'), { timeoutMs: 5000 })
    expect(actual.stdout).toBe('中文 路径')
    expect(actual.exitCode).toBe(7)
  })

  it('bounds noisy output and marks evidence as incomplete', async () => {
    const actual = await execute(node('process.stdout.write("x".repeat(4096))'), {
      timeoutMs: 5000,
      maxOutputBytes: 512
    })
    expect(actual.stdout).toHaveLength(512)
    expect(actual.outputTruncated).toBe(true)
  })

  it('kills a hung task and records timeout instead of success', async () => {
    const actual = await execute(node('setInterval(()=>{},1000)'), { timeoutMs: 300 })
    expect(actual.timedOut).toBe(true)
    expect(actual.exitCode).not.toBe(0)
  })

  it('never spawns after cancellation and reports missing executables', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(
      (await execute(node('throw new Error("must not run")'), { timeoutMs: 5000, signal: controller.signal })).cancelled
    ).toBe(true)
    expect(
      (
        await execute(
          { file: path.join(os.tmpdir(), 'does-not-exist-quality-executable'), args: [], cwd: os.tmpdir() },
          { timeoutMs: 5000 }
        )
      ).error
    ).toBeTruthy()
  })
})
