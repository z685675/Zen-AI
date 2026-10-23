import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { QUALITY_REQUEST_TIMEOUT_MS } from '../../../packages/shared/agents/opencodeLimits'
import { DEFAULT_QUALITY_PROVIDER_URL } from '../choices'
import { interactive, interactiveOptions } from '../interactive'
import { planLive } from '../live'
import { fileKinds } from '../matrix'
import { type fetchModels, parseModels } from '../models'
import { offlineEnvironment } from '../process'
import type { Options } from '../run'
import { loadCostPrompts } from '../scenarios'

const key = 'owned-interactive-fixture-credential'
const revision = { head: 'fixture', base: 'fixture', dirty: false, changedPaths: [], changeDigest: 'fixture' }

async function fixture(answers: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quality-interactive-'))
  const output: string[] = []
  const ask = vi.fn(async (question: string) => {
    if (!answers.length) throw new Error(`Unexpected extra question: ${question}`)
    return answers.shift()!
  })
  const run = vi.fn(async (options: Options & { liveValue?: any }) => {
    const config = options.liveValue
    const envName = config.providers[0].credentialEnv
    expect(process.env[envName]).toBe(key)
    expect(offlineEnvironment(process.env)[envName]).toBeUndefined()
    expect(options.approval).toBe('bound-fixture-digest')
    expect(JSON.stringify(config)).not.toContain(key)
    await writeFile(path.join(options.reportDirectory, 'report.json'), JSON.stringify(planLive(config)))
    return { exitCode: 0 }
  })
  return {
    root,
    output,
    ask,
    run,
    io: {
      ask,
      secret: vi.fn(async () => key),
      write: (text: string) => output.push(text),
      run,
      build: vi.fn(async () => {}),
      inspect: vi.fn(async () => revision),
      prepare: vi.fn(async (config) => ({
        plan: { ...planLive(config), approvalDigest: 'bound-fixture-digest' },
        scenarios: []
      })) as any,
      discover: vi.fn(async (input: Parameters<typeof fetchModels>[0]) => {
        expect(process.env[input.credentialEnv]).toBe(key)
        return parseModels({ data: Array.from({ length: 12 }, (_, i) => ({ id: `custom-chat-${i}` })) })
      })
    }
  }
}

describe('one-command real model acceptance', () => {
  it('requires only a hidden key, provider and arbitrary model selection; executes without saved config or copied digest', async () => {
    const test = await fixture(['https://fixture.invalid/v1', '1,2,3,4,5,6,7,8,9,10,11,12'])
    try {
      const result = await interactive([], test.root, undefined, test.io)
      expect(result.exitCode).toBe(0)
      expect(test.ask).toHaveBeenCalledTimes(2)
      expect(test.io.secret).toHaveBeenCalledTimes(1)
      expect(test.io.build.mock.invocationCallOrder[0]).toBeLessThan(test.io.secret.mock.invocationCallOrder[0])
      const config = test.run.mock.calls[0][0].liveValue
      expect(config.targets).toHaveLength(12)
      expect(config.targets[0].family).toBe('other')
      expect(config.budget.maxOutputTokensPerRequest).toBe(8192)
      expect(config.budget.maxOutputTokens).toBe(planLive(config).userTurns * 4000)
      expect(config.execution).toMatchObject({
        inputSizing: 'estimated-tokens',
        requestTimeoutMs: QUALITY_REQUEST_TIMEOUT_MS,
        turnTimeoutMs: 300000,
        pauseMs: 20000
      })
      expect(test.output.join('')).toContain('不是首字或辅助请求超时')
      expect(test.output.join('')).toContain('不再将中文UTF-8字节数当作Token数')
      expect(test.output.join('')).toContain('输出8192 Token')
      expect(test.output.join('')).toContain('推理Token')
      expect(process.env[config.providers[0].credentialEnv]).toBeUndefined()
      expect(await readdir(path.join(test.root, 'local'))).toEqual(['quality-reports'])
      for (const file of await readdir(result.directory))
        expect(await readFile(path.join(result.directory, file), 'utf8')).not.toContain(key)
      expect(test.output.join('')).toContain(result.directory)
      expect(test.output.join('')).toContain('可能收费')
      expect(test.output.join('')).toContain('凭据已清理')
      expect(test.output.join('')).not.toContain(key)
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it.each(['cancel', 'discovery', 'preflight', 'execution'])(
    'cleans its credential and preserves a diagnostic path on %s failure',
    async (stage) => {
      const test = await fixture(['https://fixture.invalid/v1', stage === 'cancel' ? 'q' : '1'])
      if (stage === 'discovery') test.io.discover.mockRejectedValue(new Error(`upstream ${key}`))
      if (stage === 'preflight')
        test.io.prepare.mockImplementation(async (config: unknown) => ({
          plan: { ...planLive(config), executionAvailable: false, blockers: ['missing build'], approvalDigest: '' },
          scenarios: []
        }))
      if (stage === 'execution') test.run.mockRejectedValue(new Error(`execution ${key}`))
      try {
        await expect(interactive([], test.root, undefined, test.io)).rejects.toThrow()
        const envName = test.io.discover.mock.calls[0][0].credentialEnv
        expect(process.env[envName]).toBeUndefined()
        const [name] = await readdir(path.join(test.root, 'local/quality-reports'))
        const directory = path.join(test.root, 'local/quality-reports', name)
        expect(await readFile(path.join(directory, 'setup-error.txt'), 'utf8')).not.toContain(key)
        expect(test.output.join('')).toContain(directory)
        if (stage !== 'execution') expect(test.run).not.toHaveBeenCalled()
      } finally {
        await rm(test.root, { recursive: true, force: true })
      }
    }
  )

  it('stops before credentials and model discovery if build fails', async () => {
    const test = await fixture([])
    test.io.build.mockRejectedValue(new Error('build failed'))
    try {
      await expect(interactive([], test.root, undefined, test.io)).rejects.toThrow('build failed')
      expect(test.io.secret).not.toHaveBeenCalled()
      expect(test.io.discover).not.toHaveBeenCalled()
      expect(test.run).not.toHaveBeenCalled()
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it('passes only selected file/history modules and formats through the same executor', async () => {
    const test = await fixture(['https://fixture.invalid/v1', '1,2', 'files,history', 'json,docx'])
    try {
      await interactive(['release'], test.root, undefined, test.io)
      const config = test.run.mock.calls[0][0].liveValue
      expect(config).toMatchObject({ profile: 'release', modules: ['files', 'history'], formats: ['json', 'docx'] })
      expect(
        planLive(config)
          .assignments.flatMap((assignment) => assignment.cases)
          .some((id) => id.startsWith('memory'))
      ).toBe(false)
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it('accepts Enter for all release modules and formats while still requiring image billing input', async () => {
    const test = await fixture(['https://fixture.invalid/v1', '1,2', '', '', '4096'])
    try {
      await interactive(['release'], test.root, undefined, test.io)
      const config = test.run.mock.calls[0][0].liveValue
      expect(config).toMatchObject({
        profile: 'release',
        allocation: 'mixed',
        modules: ['files', 'history', 'memory'],
        formats: fileKinds,
        vision: { maxImageTokensPerRequest: 4096, acknowledgedTokenBilling: true }
      })
      expect(test.ask).toHaveBeenCalledTimes(5)
      const ids = planLive(config).assignments.flatMap((assignment) => assignment.cases)
      for (const format of fileKinds) expect(ids).toContain(`read-${format}`)
      expect(ids).toContain('read-multiple-large')
      expect(ids).toContain('read-corrupt')
      expect(ids).toContain('history')
      expect(ids).toContain('memory-recall')
      expect(test.output.join('')).toContain('已选择：files, history, memory')
      expect(process.env[config.providers[0].credentialEnv]).toBeUndefined()
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it('accepts English-only module and format answers and retries typos without restarting setup', async () => {
    const test = await fixture(['https://fixture.invalid/v1', '1', 'file', 'FILES', 'xlsx,unknown', 'XLSX'])
    try {
      await interactive(['release'], test.root, undefined, test.io)
      const config = test.run.mock.calls[0][0].liveValue
      expect(config).toMatchObject({ modules: ['files'], formats: ['xlsx'] })
      expect(config.vision).toBeUndefined()
      expect(test.io.secret).toHaveBeenCalledTimes(1)
      expect(test.io.discover).toHaveBeenCalledTimes(1)
      expect(test.io.build).toHaveBeenCalledTimes(1)
      expect(test.run).toHaveBeenCalledTimes(1)
      expect(test.output.join('')).toContain('选择无效')
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it('skips format selection for a single history module', async () => {
    const test = await fixture(['https://fixture.invalid/v1', '1', 'history'])
    try {
      await interactive(['release'], test.root, undefined, test.io)
      const config = test.run.mock.calls[0][0].liveValue
      expect(config.modules).toEqual(['history'])
      expect(config.formats).toBeUndefined()
      expect(config.vision).toBeUndefined()
      expect(test.ask).toHaveBeenCalledTimes(3)
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it('re-prompts an empty image reservation and continues without rebuilding or asking for credentials again', async () => {
    const test = await fixture(['', '1', '', '', '', 'invalid', '0', '8192'])
    try {
      await interactive(['release'], test.root, undefined, test.io)
      const config = test.run.mock.calls[0][0].liveValue
      expect(config.providers[0].baseURL).toBe(DEFAULT_QUALITY_PROVIDER_URL)
      expect(config).toMatchObject({
        formats: fileKinds,
        modules: ['files', 'history', 'memory'],
        vision: { maxImageTokensPerRequest: 8192, acknowledgedTokenBilling: true }
      })
      expect(test.io.secret).toHaveBeenCalledTimes(1)
      expect(test.io.build).toHaveBeenCalledTimes(1)
      expect(test.io.discover).toHaveBeenCalledTimes(1)
      expect(test.io.discover.mock.calls[0][0].baseURL).toBe(DEFAULT_QUALITY_PROVIDER_URL)
      expect(test.io.prepare).toHaveBeenCalledTimes(1)
      expect(test.run).toHaveBeenCalledTimes(1)
      expect(test.output.join('')).toContain('图片Token预留不能为空')
      expect(process.env[config.providers[0].credentialEnv]).toBeUndefined()
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it('allows returning from image billing and uses only the newly selected formats', async () => {
    const test = await fixture(['', '1', '', '', 'b', 'json,docx,xlsx,pptx,pdf'])
    try {
      await interactive(['release'], test.root, undefined, test.io)
      const config = test.run.mock.calls[0][0].liveValue
      expect(config.formats).toEqual(['json', 'docx', 'xlsx', 'pptx', 'pdf'])
      expect(config.vision).toBeUndefined()
      const ids = planLive(config).assignments.flatMap((assignment) => assignment.cases)
      expect(ids).not.toContain('read-png')
      expect(ids).not.toContain('read-jpg')
      expect(ids).toContain('memory-recall')
      expect(test.io.secret).toHaveBeenCalledTimes(1)
      expect(test.io.discover).toHaveBeenCalledTimes(1)
      expect(test.output.join('')).toContain('已返回文件格式选择')
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it('does not interpret a blank image reservation as billing approval and lets the user cancel', async () => {
    const test = await fixture(['https://fixture.invalid/v1', '1', '', '', '', 'q'])
    try {
      await expect(interactive(['release'], test.root, undefined, test.io)).rejects.toThrow('已取消选择')
      expect(test.run).not.toHaveBeenCalled()
      expect(test.io.prepare).not.toHaveBeenCalled()
      expect(process.env[test.io.discover.mock.calls[0][0].credentialEnv]).toBeUndefined()
      expect(test.output.join('')).not.toContain('Too small')
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it('uses Enter for the default API but re-prompts invalid addresses rather than silently changing them', async () => {
    const test = await fixture(['invalid', '', '1'])
    try {
      await interactive([], test.root, undefined, test.io)
      const config = test.run.mock.calls[0][0].liveValue
      expect(config.providers[0].baseURL).toBe(DEFAULT_QUALITY_PROVIDER_URL)
      expect(test.output.join('')).toContain('API地址无效')
      expect(test.io.discover).toHaveBeenCalledTimes(1)
      expect(test.io.secret).toHaveBeenCalledTimes(1)
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it('cleans credentials when cancelling the API step before model discovery', async () => {
    const test = await fixture(['q'])
    try {
      await expect(interactive([], test.root, undefined, test.io)).rejects.toThrow('已取消选择')
      expect(test.io.discover).not.toHaveBeenCalled()
      expect(test.run).not.toHaveBeenCalled()
      expect(Object.keys(process.env).filter((name) => /^ZEN_QUALITY_SESSION_.*_KEY$/.test(name))).toEqual([])
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it('cleans credentials when cancelling module selection without generating', async () => {
    const test = await fixture(['https://fixture.invalid/v1', '1', 'q'])
    try {
      await expect(interactive(['release'], test.root, undefined, test.io)).rejects.toThrow('已取消选择')
      expect(test.run).not.toHaveBeenCalled()
      expect(process.env[test.io.discover.mock.calls[0][0].credentialEnv]).toBeUndefined()
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it('reads the independent twenty-round text before asking for any credentials', async () => {
    const test = await fixture(['https://fixture.invalid/v1', '1'])
    try {
      const prompts = path.join(test.root, 'prompts.txt')
      await writeFile(
        prompts,
        '\uFEFF' + Array.from({ length: 20 }, (_, i) => `第${i + 1}轮\n动作${i + 1}\n`).join('\n')
      )
      expect(await loadCostPrompts(prompts)).toHaveLength(20)
      await interactive(['cost', '--prompts', prompts], test.root, undefined, test.io)
      expect(test.run.mock.calls[0][0].liveValue).toMatchObject({
        profile: 'cost',
        allocation: 'all-models',
        execution: { costPromptFile: prompts }
      })
      await writeFile(prompts, '第1轮\n只有一轮\n')
      test.io.secret.mockClear()
      await expect(interactive(['cost', '--prompts', prompts], test.root, undefined, test.io)).rejects.toThrow('第20轮')
      expect(test.io.secret).not.toHaveBeenCalled()
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it('validates CLI profiles and numeric boundaries without an extra wizard', () => {
    expect(() => interactiveOptions(['cost'])).toThrow('--prompts')
    expect(() => interactiveOptions(['quick', '--prompts', 'x'])).toThrow('常规验收')
    expect(() => interactiveOptions(['--api-key', 'no-secrets-in-args'])).toThrow('参数无效')
    expect(() => interactiveOptions(['--entries', 'unknown'])).toThrow('--entries')
    expect(() => interactiveOptions(['--max-requests', '1.1']).number('--max-requests', 60)).toThrow('整数')
  })

  it('keeps explicitly shorter request and turn limits instead of raising them to the defaults', async () => {
    const test = await fixture(['https://fixture.invalid/v1', '1'])
    try {
      await interactive(['--request-timeout-ms', '1000', '--turn-timeout-ms', '2000'], test.root, undefined, test.io)
      expect(test.run.mock.calls[0][0].liveValue.execution).toMatchObject({
        requestTimeoutMs: 1000,
        turnTimeoutMs: 2000,
        pauseMs: 20000
      })
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })

  it.each([1024, 16384])(
    'supports an explicit per-call output reserve of %i without changing batch limits',
    async (reserve) => {
      const test = await fixture(['https://fixture.invalid/v1', '1'])
      try {
        await interactive(
          ['--output-reserve', String(reserve), '--max-output-tokens', '50000'],
          test.root,
          undefined,
          test.io
        )
        expect(test.run.mock.calls[0][0].liveValue.budget).toMatchObject({
          maxOutputTokensPerRequest: reserve,
          maxOutputTokens: 50000,
          maxRequests: 60,
          maxRequestsPerTurn: 8
        })
        expect(test.output.join('')).toContain(`输出${reserve} Token`)
      } finally {
        await rm(test.root, { recursive: true, force: true })
      }
    }
  )

  it.each(['0', '32769', '1.5', '-1'])(
    'rejects an invalid per-request output reserve %s before execution',
    async (reserve) => {
      const test = await fixture(['https://fixture.invalid/v1', '1'])
      try {
        await expect(interactive(['--output-reserve', reserve], test.root, undefined, test.io)).rejects.toThrow()
        expect(test.run).not.toHaveBeenCalled()
      } finally {
        await rm(test.root, { recursive: true, force: true })
      }
    }
  )

  it('does not silently increase an explicit batch limit to fit the per-call reservation', async () => {
    const test = await fixture(['https://fixture.invalid/v1', '1'])
    try {
      await expect(interactive(['--max-output-tokens', '4096'], test.root, undefined, test.io)).rejects.toThrow(
        '不足以预留'
      )
      expect(test.run).not.toHaveBeenCalled()
    } finally {
      await rm(test.root, { recursive: true, force: true })
    }
  })
})
