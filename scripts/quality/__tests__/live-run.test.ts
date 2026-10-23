import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { TOPIC_NAMING_REQUEST_HEADERS } from '../../../packages/shared/diagnostics'
import { listenOnLoopback } from '../../../packages/shared/utils/loopbackServer'
import { prepareLivePlan } from '../approval'
import {
  checkToolOutput,
  closeIsolated,
  launchIsolated,
  openEntry,
  prepareToolFixture,
  readMessages,
  seedModel,
  sendUI,
  verifyIsolatedPython
} from '../electron'
import { runLive } from '../live-run'
import { createFileTaskPermissionGuard } from '../native-write-permission'
import { prepareQualityPython } from '../python-runtime'
import { liveFixture } from './fixtures'

vi.mock('../approval', () => ({ prepareLivePlan: vi.fn() }))
vi.mock('../selection', () => ({ inspectRevision: vi.fn(async () => ({})) }))
vi.mock('../native-write-permission', () => ({ createFileTaskPermissionGuard: vi.fn() }))
vi.mock('../python-runtime', () => ({ prepareQualityPython: vi.fn() }))
vi.mock('../electron', () => ({
  launchIsolated: vi.fn(),
  closeIsolated: vi.fn(),
  seedModel: vi.fn(),
  openEntry: vi.fn(),
  sendUI: vi.fn(),
  readMessages: vi.fn(),
  prepareToolFixture: vi.fn(),
  checkToolOutput: vi.fn(),
  verifyIsolatedPython: vi.fn(async () => {})
}))

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('real executor fail-closed preflight and denominator', () => {
  const setup = (userTurns = 5) => {
    vi.mocked(prepareQualityPython).mockResolvedValue({
      cacheDir: '/fixture-python',
      key: 'fixture',
      release: vi.fn(async () => {})
    })
    vi.mocked(readMessages).mockResolvedValue([])
    vi.mocked(prepareLivePlan).mockResolvedValue({
      plan: { executionAvailable: true, blockers: [], approvalDigest: 'approved', userTurns },
      scenarios: [
        { id: 'one', prompt: '你好' },
        { id: 'two', prompt: '继续' }
      ]
    } as any)
    const value = liveFixture()
    value.targets[0].entries = ['chat', 'assistant']
    const report = { cases: [], network: { paidCallsAuthorized: false }, limitations: [] } as any
    return {
      value,
      report,
      approval: 'approved',
      root: 'not-read-after-mock',
      signal: undefined,
      checkpoint: async () => {}
    }
  }
  it('rejects an outdated approval before key lookup or app launch', async () => {
    const input = setup()
    await expect(runLive({ ...input, directory: 'never-created', approval: 'old' })).rejects.toThrow('摘要不匹配')
    expect(launchIsolated).not.toHaveBeenCalled()
    expect(input.report.network.paidCallsAuthorized).toBe(false)
  })
  it('cancels before reading any key or launching an application', async () => {
    const input = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(runLive({ ...input, directory: 'never-created', signal: controller.signal })).rejects.toThrow(
      '未读取凭据'
    )
    expect(launchIsolated).not.toHaveBeenCalled()
    expect(input.report.network.paidCallsAuthorized).toBe(false)
    expect(input.report.cases).toHaveLength(0)
  })
  it('blocks the entire paid batch if the free Python preflight fails, without blaming a model', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-python-blocked-'))
    const input = setup()
    vi.stubEnv('ZEN_QUALITY_FIXTURE_KEY', 'local-placeholder-never-sent')
    vi.mocked(prepareQualityPython).mockRejectedValue(new Error('合成运行时下载失败'))
    try {
      await runLive({ ...input, directory })
      expect(launchIsolated).not.toHaveBeenCalled()
      expect(seedModel).not.toHaveBeenCalled()
      expect(sendUI).not.toHaveBeenCalled()
      expect(input.report.network.paidCallsAuthorized).toBe(false)
      expect(input.report.cases).toHaveLength(6)
      expect(input.report.cases.every((item: any) => item.status === 'environment_blocked')).toBe(true)
      expect(input.report.liveResult).toMatchObject({
        completedUserTurns: 0,
        expectedUserTurns: 5,
        tokens: { requests: 0 }
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('does not prepare Python for a chat-only batch', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-chat-no-python-'))
    const input = setup(2)
    input.value.targets[0].entries = ['chat']
    vi.stubEnv('ZEN_QUALITY_FIXTURE_KEY', 'local-placeholder-never-sent')
    vi.mocked(launchIsolated).mockRejectedValue(new Error('synthetic startup failed'))
    try {
      await expect(runLive({ ...input, directory })).rejects.toThrow('startup failed')
      expect(prepareQualityPython).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('checks Python again in the actual product before seeding any model or sending messages', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-product-python-blocked-'))
    const input = setup(3)
    input.value.targets[0].entries = ['assistant']
    vi.stubEnv('ZEN_QUALITY_FIXTURE_KEY', 'local-placeholder-never-sent')
    vi.mocked(launchIsolated).mockResolvedValue({ instance: directory, application: {}, page: {} } as any)
    vi.mocked(verifyIsolatedPython).mockRejectedValueOnce(new Error('合成挂载失败'))
    vi.mocked(closeIsolated).mockResolvedValue(undefined)
    try {
      await runLive({ ...input, directory })
      expect(seedModel).not.toHaveBeenCalled()
      expect(sendUI).not.toHaveBeenCalled()
      expect(closeIsolated).toHaveBeenCalledOnce()
      expect(
        input.report.cases
          .filter((item: any) => item.id !== 'LIVE-PYTHON')
          .every((item: any) => item.status === 'environment_blocked')
      ).toBe(true)
      expect(input.report.liveResult.tokens.requests).toBe(0)
      expect((await vi.mocked(prepareQualityPython).mock.results[0].value).release).toHaveBeenCalledOnce()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('leaves all planned cases not_run after startup failure, records zero paid requests', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-executor-'))
    try {
      const input = setup()
      vi.stubEnv('ZEN_QUALITY_FIXTURE_KEY', 'local-placeholder-never-sent')
      vi.mocked(launchIsolated).mockRejectedValue(new Error('synthetic startup failed'))
      await expect(runLive({ ...input, directory })).rejects.toThrow('synthetic startup failed')
      expect(input.report.cases).toHaveLength(6)
      expect(
        input.report.cases
          .filter((item: any) => item.id !== 'LIVE-PYTHON')
          .every((item: any) => item.status === 'not_run')
      ).toBe(true)
      expect(input.report.liveResult).toMatchObject({
        completedUserTurns: 0,
        expectedUserTurns: 5,
        tokens: { requests: 0 }
      })
      const cost = JSON.parse(await readFile(path.join(directory, 'cost-summary.json'), 'utf8'))
      expect(cost.groups[0].all).toMatchObject({ plannedUserTurns: 2, userTurns: 0, modelCalls: 0 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('does not require prices for an acknowledged token batch and keeps null costs on startup failure', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-unpriced-executor-'))
    try {
      const input = setup()
      const value = {
        ...input.value,
        prices: undefined,
        budget: {
          ...input.value.budget,
          mode: 'tokens',
          acknowledgedUnknownCost: true,
          currency: undefined,
          maxAmount: undefined
        }
      }
      vi.stubEnv('ZEN_QUALITY_FIXTURE_KEY', 'local-placeholder-never-sent')
      vi.mocked(launchIsolated).mockRejectedValue(new Error('synthetic startup failed'))
      await expect(runLive({ ...input, value, directory })).rejects.toThrow('synthetic startup failed')
      expect(input.report.liveResult).toMatchObject({
        money: { amount: null, limit: null, basis: 'unpriced-token-limits-only' },
        tokens: { requests: 0 }
      })
      const cost = JSON.parse(await readFile(path.join(directory, 'cost-summary.json'), 'utf8'))
      expect(cost.groups[0].all.estimatedAmount).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('keeps failed answer evidence without counting an observation as a completed question', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-failed-observation-'))
    try {
      const input = setup()
      vi.stubEnv('ZEN_QUALITY_FIXTURE_KEY', 'local-placeholder-never-sent')
      vi.mocked(launchIsolated).mockResolvedValue({
        instance: directory,
        application: {},
        page: {
          screenshot: vi.fn(async () => {}),
          url: () => 'file:///owned-fixture',
          locator: () => ({ innerText: async () => '合成测试页面' })
        }
      } as any)
      vi.mocked(sendUI).mockResolvedValue({ answer: '合成回答', firstTextMs: 1, totalMs: 2, messageIds: ['owned'] })
      vi.mocked(readMessages).mockResolvedValue([
        { id: 'owned', role: 'assistant', status: 'success', text: '合成回答' }
      ])
      await runLive({ ...input, directory })
      expect(input.report.liveResult.completedUserTurns).toBe(0)
      expect(input.report.cases[0].status).toBe('failed')
      expect(input.report.cases[2].status).toBe('failed')
      expect([1, 3, 4].every((index) => input.report.cases[index].status === 'not_run')).toBe(true)
      const observations = JSON.parse(await readFile(path.join(directory, 'live-observations.json'), 'utf8'))
      expect(observations[0]).toMatchObject({ failed: true, partial: [{ text: '合成回答' }] })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses the approved estimated input policy in execution and persists structural evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-estimated-input-'))
    const server = createServer((_req, res) =>
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 45000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 30000 } }
        })
      )
    )
    await listenOnLoopback(server)
    const input = setup(2)
    const value = {
      ...input.value,
      targets: [{ ...input.value.targets[0], entries: ['chat'] }],
      prices: undefined,
      providers: [
        { ...input.value.providers[0], baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }
      ],
      execution: { ...input.value.execution, maxInputTokensPerRequest: 128000, inputSizing: 'estimated-tokens' },
      budget: {
        ...input.value.budget,
        mode: 'tokens',
        acknowledgedUnknownCost: true,
        currency: undefined,
        maxAmount: undefined
      }
    }
    let selected: Parameters<typeof seedModel>[1]
    vi.mocked(seedModel).mockImplementation(async (_page, model) => {
      selected = model
    })
    vi.mocked(launchIsolated).mockResolvedValue({
      instance: directory,
      application: {},
      page: {
        screenshot: vi.fn(async () => {}),
        url: () => 'file:///owned-fixture',
        locator: () => ({ innerText: async () => '合成页面' })
      }
    } as any)
    vi.mocked(sendUI).mockImplementation(async () => {
      const response = await fetch(selected.url + '/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${selected.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: selected.modelId,
          messages: [{ role: 'user', content: '合成资料'.repeat(12000) }]
        })
      })
      expect(response.status).toBe(200)
      await response.text()
      return { answer: '完成', firstTextMs: 1, totalMs: 2, messageIds: ['owned'] }
    })
    vi.stubEnv('ZEN_QUALITY_FIXTURE_KEY', 'local-placeholder-never-sent')
    try {
      await runLive({ ...input, value, directory })
      expect(input.report.liveResult.completedUserTurns).toBe(2)
      const calls = JSON.parse(await readFile(path.join(directory, 'target-0-chat/calls.json'), 'utf8'))
      expect(calls.calls).toHaveLength(2)
      for (const call of calls.calls)
        expect(call).toMatchObject({
          completed: true,
          inputSizing: { strategy: 'estimated-tokens', safetyMultiplier: 2 },
          response: { outcome: 'complete', framing: 'json', reachedEof: true }
        })
      expect(input.report.limitations.join('')).toContain('×2安全余量')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([false, true])(
    'continues independent sessions after failure/recovery, but stops on global budget: %s',
    async (stopOnBudget) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-native-retry-'))
      let upstreamCalls = 0
      const server = createServer((_req, res) => {
        if (++upstreamCalls <= 2) res.writeHead(503).end('{"error":{"message":"local transient failure"}}')
        else
          res.end(
            JSON.stringify({
              choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } }
            })
          )
      })
      await listenOnLoopback(server)
      const input = setup(8)
      const target = input.value.targets[0]
      const value = {
        ...input.value,
        profile: 'cost',
        targets: [target, { ...target, modelId: 'another' }],
        providers: [
          { ...input.value.providers[0], baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }
        ],
        prices: [...input.value.prices, { ...input.value.prices[0], modelId: 'another' }],
        execution: { ...input.value.execution, costPromptFile: 'mocked.txt' },
        budget: { ...input.value.budget, maxRequests: stopOnBudget ? 1 : 20 }
      }
      let selected: Parameters<typeof seedModel>[1]
      let entry: string
      vi.mocked(seedModel).mockImplementation(async (_page, model) => {
        selected = model
      })
      vi.mocked(openEntry).mockImplementation(async (_page, next) => {
        entry = next
      })
      vi.mocked(launchIsolated).mockResolvedValue({
        instance: directory,
        application: {},
        page: {
          screenshot: vi.fn(async () => {}),
          url: () => 'file:///owned-fixture',
          locator: () => ({ innerText: async () => '合成测试页面' })
        }
      } as any)
      vi.mocked(sendUI).mockImplementation(async (_page, prompt, _timeout, _signal, progress) => {
        const request = () =>
          fetch(selected.url + '/chat/completions', {
            method: 'POST',
            headers: { authorization: `Bearer ${selected.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: selected.modelId, messages: [{ role: 'user', content: prompt }] })
          })
        const response = await request()
        await response.text()
        await progress?.checkFailure?.()
        if (response.status === 503) {
          if (!stopOnBudget && selected.modelId === 'chosen' && entry === 'chat') throw new Error('产品最终失败')
          const retried = await request()
          await retried.text()
          await progress?.checkFailure?.()
          expect(retried.status).toBe(200)
        }
        return { answer: '完成', firstTextMs: 1, totalMs: 2, messageIds: ['owned'] }
      })
      vi.stubEnv('ZEN_QUALITY_FIXTURE_KEY', 'local-placeholder-never-sent')
      try {
        if (stopOnBudget) {
          await expect(runLive({ ...input, value, directory })).rejects.toThrow('budget exhausted')
          expect(launchIsolated).toHaveBeenCalledTimes(1)
          expect(upstreamCalls).toBe(1)
          expect(input.report.liveResult.tokens.stopped).toBe(true)
        } else {
          await runLive({ ...input, value, directory })
          expect(launchIsolated).toHaveBeenCalledTimes(4)
          expect(closeIsolated).toHaveBeenCalledTimes(4)
          expect(input.report.cases.map((item: any) => item.status)).toEqual([
            'failed',
            'not_run',
            'passed',
            'passed',
            'passed',
            'passed',
            'passed',
            'passed'
          ])
          expect(input.report.cases[2].detail).toContain('原生重试后恢复')
          expect(input.report.liveResult.completedUserTurns).toBe(6)
          const cost = JSON.parse(await readFile(path.join(directory, 'cost-summary.json'), 'utf8'))
          expect(cost.groups[1].all).toMatchObject({
            completedUserTurns: 2,
            modelCalls: 3,
            failedCalls: 1,
            missingUsage: 1
          })
          expect(upstreamCalls).toBe(8)
        }
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.each([false, true])(
    'continues later turns with naming warnings, but requires main evidence: namingOnly=%s',
    async (namingOnly) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-naming-warning-'))
      let upstreamCalls = 0
      const server = createServer((_req, res) => {
        if (++upstreamCalls % 2 === 0 || namingOnly) res.writeHead(400).end('{}')
        else
          res.end(
            JSON.stringify({
              choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } }
            })
          )
      })
      await listenOnLoopback(server)
      try {
        const input = setup(4)
        input.value.profile = 'cost'
        input.value.execution.costPromptFile = 'mocked.txt'
        input.value.budget.maxRequests = 20
        input.value.providers[0].baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
        vi.stubEnv('ZEN_QUALITY_FIXTURE_KEY', 'local-placeholder-never-sent')
        vi.mocked(launchIsolated).mockResolvedValue({
          instance: directory,
          application: {},
          page: {
            screenshot: vi.fn(async () => {}),
            url: () => 'file:///owned-fixture',
            locator: () => ({ innerText: async () => '合成测试页面' })
          }
        } as any)
        let selected: Parameters<typeof seedModel>[1]
        vi.mocked(seedModel).mockImplementation(async (_page, model) => {
          selected = model
        })
        vi.mocked(sendUI).mockImplementation(async (_page, prompt, _timeout, _signal, progress) => {
          const request = (naming: boolean) =>
            fetch(selected.url + '/chat/completions', {
              method: 'POST',
              headers: {
                authorization: `Bearer ${selected.token}`,
                'content-type': 'application/json',
                ...(naming ? TOPIC_NAMING_REQUEST_HEADERS : {})
              },
              body: JSON.stringify({ model: selected.modelId, messages: [{ role: 'user', content: prompt }] })
            })
          if (!namingOnly) await (await request(false)).text()
          await (await request(true)).text()
          await progress?.checkFailure?.()
          return { answer: '完成', firstTextMs: 1, totalMs: 2, messageIds: ['owned'] }
        })
        await runLive({ ...input, directory })
        if (namingOnly) {
          expect(input.report.liveResult.completedUserTurns).toBe(0)
          expect(input.report.cases[0].detail).toContain('主任务成功调用证据')
        } else {
          expect(sendUI).toHaveBeenCalledTimes(4)
          expect(input.report.cases.every((item: any) => item.status === 'passed')).toBe(true)
          expect(input.report.cases.every((item: any) => item.warnings?.[0].includes('自动命名失败'))).toBe(true)
          expect(input.report.cases.every((item: any) => !item.detail?.includes('原生重试后恢复'))).toBe(true)
          expect(input.report.liveResult).toMatchObject({ completedUserTurns: 4, tokens: { requests: 8 } })
          const evidence = JSON.parse(await readFile(path.join(directory, 'target-0-chat/calls.json'), 'utf8'))
          expect(evidence.calls.filter((call: any) => call.purpose === 'topic-naming')).toHaveLength(2)
        }
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.each(['cleanup-failure', 'cancelled'] as const)(
    'does not launch the next isolated session after %s',
    async (reason) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-cleanup-boundary-'))
      const input = setup()
      const controller = new AbortController()
      vi.stubEnv('ZEN_QUALITY_FIXTURE_KEY', 'local-placeholder-never-sent')
      vi.mocked(launchIsolated).mockResolvedValue({
        instance: directory,
        application: {},
        page: {
          screenshot: vi.fn(async () => {}),
          url: () => 'file:///owned-fixture',
          locator: () => ({ innerText: async () => '合成测试页面' })
        }
      } as any)
      vi.mocked(closeIsolated).mockResolvedValue(undefined)
      if (reason === 'cleanup-failure')
        vi.mocked(closeIsolated).mockRejectedValueOnce(new Error('隔离应用未正常退出（exit=null）'))
      vi.mocked(sendUI).mockImplementation(async () => {
        if (reason === 'cancelled') controller.abort()
        throw new Error(reason === 'cancelled' ? '合成用户取消' : '合成会话失败')
      })
      try {
        await expect(runLive({ ...input, directory, signal: controller.signal })).rejects.toThrow(
          reason === 'cancelled' ? '合成用户取消' : '本批取消/超时'
        )
        expect(launchIsolated).toHaveBeenCalledOnce()
        expect(closeIsolated).toHaveBeenCalledOnce()
        expect(sendUI).toHaveBeenCalledOnce()
        expect(input.report.cases[0].status).toBe(reason === 'cancelled' ? 'cancelled' : 'failed')
        expect(input.report.cases.slice(1, 5).every((item: any) => item.status === 'not_run')).toBe(true)
        const cleanup = input.report.cases.filter((item: any) => item.id.endsWith('-APP-CLEANUP'))
        if (reason === 'cleanup-failure')
          expect(cleanup).toEqual([
            expect.objectContaining({ status: 'failed', detail: expect.stringContaining('exit=null') })
          ])
        else expect(cleanup).toHaveLength(0)
        expect(input.report.liveResult).toMatchObject({
          completedUserTurns: 0,
          tokens: { requests: 0, stopped: true }
        })
      } finally {
        vi.mocked(closeIsolated).mockResolvedValue(undefined)
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.each([
    { denyShell: false, invalidOutput: false },
    { denyShell: true, invalidOutput: false },
    { denyShell: true, invalidOutput: true }
  ])('checks file output after UI decisions: %j', async ({ denyShell, invalidOutput }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-live-permission-'))
    const server = createServer((_req, res) => {
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 1 }
        })
      )
    })
    await listenOnLoopback(server)
    try {
      const input = setup(3)
      input.value.targets[0].entries = ['assistant']
      input.value.providers[0].baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
      vi.stubEnv('ZEN_QUALITY_FIXTURE_KEY', 'local-placeholder-never-sent')
      const page = {
        screenshot: vi.fn(),
        url: () => 'file:///owned-fixture',
        locator: () => ({ innerText: async () => '合成文件任务页面' })
      }
      const fixture = { workspace: directory, source: 'source', output: 'result', content: 'source', prompt: 'tool' }
      const approved = [
        { requestId: 'permission', toolCallId: 'write-call', output: 'result', expandedFromHeader: true }
      ]
      const denied = denyShell
        ? [{ requestId: 'shell-permission', toolCallId: 'shell-call', toolName: 'bash', expandedFromHeader: false }]
        : []
      const checkPermission = vi.fn(async () => {})
      vi.mocked(checkToolOutput).mockImplementation(async () => {
        if (invalidOutput) throw new Error('实际产物缺失或合计不正确')
      })
      vi.mocked(launchIsolated).mockResolvedValue({ instance: directory, application: {}, page } as any)
      vi.mocked(prepareToolFixture).mockResolvedValue(fixture)
      vi.mocked(createFileTaskPermissionGuard).mockResolvedValue({ approved, denied, checkPermission })
      let selected: Parameters<typeof seedModel>[1]
      vi.mocked(seedModel).mockImplementation(async (_page, model) => {
        selected = model
      })
      vi.mocked(sendUI).mockImplementation(async (_page, prompt, _timeout, _signal, progress) => {
        const response = await fetch(selected.url + '/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${selected.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: selected.modelId, messages: [{ role: 'user', content: prompt }] })
        })
        await response.text()
        await progress?.checkFailure?.()
        return { answer: '完成', firstTextMs: 1, totalMs: 2, messageIds: ['owned'] }
      })
      await runLive({ ...input, directory })
      expect(createFileTaskPermissionGuard).toHaveBeenCalledExactlyOnceWith(page, directory, fixture)
      expect(checkPermission).toHaveBeenCalledOnce()
      expect(input.report.cases.map((item: any) => item.status)).toEqual([
        'passed',
        'passed',
        invalidOutput ? 'failed' : 'passed',
        'passed'
      ])
      expect(checkToolOutput).toHaveBeenCalledExactlyOnceWith(fixture)
      const observations = JSON.parse(await readFile(path.join(directory, 'live-observations.json'), 'utf8'))
      expect(observations).toContainEqual(
        expect.objectContaining({ nativeWriteApprovals: approved, deniedPermissions: denied })
      )
      if (invalidOutput) {
        expect(input.report.cases[2].detail).toContain('实际产物缺失')
        expect(input.report.liveResult.completedUserTurns).toBe(2)
        expect(observations).toContainEqual(expect.objectContaining({ failed: true, deniedPermissions: denied }))
      } else if (denyShell) expect(input.report.cases[2].warnings[0]).toContain('未授权的 bash')
    } finally {
      vi.mocked(checkToolOutput).mockReset()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  })
})
