import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  OPENCODE_HEADERS_TIMEOUT_MS,
  OPENCODE_REQUEST_TIMEOUT_MS,
  OPENCODE_STREAM_CHUNK_TIMEOUT_MS,
  QUALITY_REQUEST_TIMEOUT_MS
} from '../../../packages/shared/agents/opencodeLimits'
import { DEFAULT_QUALITY_PROVIDER_URL } from '../choices'
import { configure } from '../configure'
import { planLive } from '../live'
import { fileKinds } from '../matrix'
import { parseModels } from '../models'

describe('simple model picker configuration wizard', () => {
  const answers = () => ['https://owned-fixture.invalid/v1', '', '', '1,2,3', '', '', '', '', 'yes']
  const discover = async () =>
    parseModels({ data: ['gemini-3.8-flash', 'claude-sonnet-5-5', 'grok-4-7'].map((id) => ({ id })) })
  it('fetches list then writes a usable three-model unpriced plan without asking for any prices or keys', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-configure-'))
    try {
      const remaining = answers()
      const ask = vi.fn(async (_question: string) => {
        if (!remaining.length) throw new Error(`Unexpected extra wizard question: ${_question}`)
        return remaining.shift()!
      })
      const output = vi.fn()
      const config = await configure({ ask, write: output, directory, discover })
      expect(remaining).toHaveLength(0)
      const saved = JSON.parse(await readFile(config.file, 'utf8'))
      expect(saved).toMatchObject({ allocation: 'mixed', budget: { mode: 'tokens', acknowledgedUnknownCost: true } })
      expect(saved.targets).toHaveLength(3)
      expect(saved).not.toHaveProperty('prices')
      expect(saved.budget).not.toHaveProperty('maxAmount')
      expect(saved.budget).not.toHaveProperty('currency')
      expect(saved.budget).toMatchObject({ maxOutputTokensPerRequest: 8192, maxOutputTokens: 60000, maxRequests: 60 })
      expect(saved.execution).toMatchObject({
        inputSizing: 'estimated-tokens',
        requestTimeoutMs: QUALITY_REQUEST_TIMEOUT_MS,
        turnTimeoutMs: 300000,
        pauseMs: 20000
      })
      expect(QUALITY_REQUEST_TIMEOUT_MS).toBeLessThan(OPENCODE_REQUEST_TIMEOUT_MS)
      expect([
        OPENCODE_HEADERS_TIMEOUT_MS,
        OPENCODE_STREAM_CHUNK_TIMEOUT_MS,
        OPENCODE_REQUEST_TIMEOUT_MS,
        QUALITY_REQUEST_TIMEOUT_MS
      ]).toEqual([120000, 120000, 600000, 185000])
      expect(planLive(saved)).toMatchObject({ executionAvailable: true, userTurns: 15 })
      expect(ask.mock.calls.map(([question]) => question).join('')).not.toMatch(
        /报价依据|普通输入价格|缓存读取价格|最高金额/
      )
      expect(output.mock.calls.flat().join('')).toContain('没有保存Key或启动生成')
      expect(output.mock.calls.flat().join('')).toContain('不是首字或辅助请求超时')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('does not save or execute if unknown cost is not acknowledged', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-configure-cancel-'))
    try {
      const remaining = answers()
      remaining[remaining.length - 1] = 'no'
      await expect(
        configure({ ask: async () => remaining.shift()!, write: () => {}, directory, discover })
      ).rejects.toThrow('未确认')
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses the same default API and retries an empty image reservation in release configuration', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-configure-release-'))
    const remaining = ['', '', '', '1', 'release', '', '', '', '', '4096', '', '', 'yes']
    try {
      const config = await configure({
        ask: async (question) => {
          if (!remaining.length) throw new Error(`Unexpected extra wizard question: ${question}`)
          return remaining.shift()!
        },
        write: () => {},
        directory,
        discover
      })
      expect(remaining).toHaveLength(0)
      const saved = JSON.parse(await readFile(config.file, 'utf8'))
      expect(saved).toMatchObject({
        providers: [{ baseURL: DEFAULT_QUALITY_PROVIDER_URL }],
        modules: ['files', 'history', 'memory'],
        formats: fileKinds,
        vision: { maxImageTokensPerRequest: 4096, acknowledgedTokenBilling: true }
      })
      expect(planLive(saved).executionAvailable).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns to file selection rather than saving unconfirmed image billing', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-configure-files-'))
    const remaining = ['', '', '', '1', 'release', '', '', '', 'b', 'xlsx', '', '', 'yes']
    try {
      const config = await configure({
        ask: async (question) => {
          if (!remaining.length) throw new Error(`Unexpected extra wizard question: ${question}`)
          return remaining.shift()!
        },
        write: () => {},
        directory,
        discover
      })
      const saved = JSON.parse(await readFile(config.file, 'utf8'))
      expect(remaining).toHaveLength(0)
      expect(saved.formats).toEqual(['xlsx'])
      expect(saved.vision).toBeUndefined()
      expect(planLive(saved).executionAvailable).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
