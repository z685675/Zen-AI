import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { listenOnLoopback } from '../../../packages/shared/utils/loopbackServer'
import { chooseModels, fetchModels, parseModels, providerURL, selectModels } from '../models'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const ids = ['grok-4-7', 'claude-sonnet-5-5', 'gemini-3.8-flash', 'gpt-image2.5']
const list = () => parseModels({ data: ids.map((id) => ({ id })) })

describe('explicit model selection before acceptance', () => {
  it('preserves exact IDs, deduplicates, classifies family only, and flags obvious non-chat models', () => {
    expect(parseModels({ data: [...ids, ids[0]].map((id) => ({ id })) })).toEqual(list())
    expect(list()).toMatchObject([
      { id: 'claude-sonnet-5-5', family: 'claude', nonChat: false },
      { id: 'gemini-3.8-flash', family: 'gemini', nonChat: false },
      { id: 'gpt-image2.5', family: 'gpt', nonChat: true },
      { id: 'grok-4-7', family: 'grok', nonChat: false }
    ])
    expect(parseModels({ data: [{ id: 'vendor/custom-chat' }] })[0].family).toBeNull()
    for (const id of [' bad', 'bad\nname', 'escape\u001b[31m', 'fake\u202emodel', 'x'.repeat(201)])
      expect(() => parseModels({ data: [{ id }] })).toThrow('无效ID')
    expect(() => parseModels({ data: [null] })).toThrow()
    expect(() => parseModels({ models: [] })).toThrow('格式')
  })
  it('accepts any positive number of distinct in-list chat candidates, never guessed IDs', () => {
    expect(selectModels(list(), '4，2,1').map((model) => model.id)).toEqual([ids[0], ids[2], ids[1]])
    expect(selectModels(list(), '1')).toHaveLength(1)
    expect(selectModels(list(), '1,2')).toHaveLength(2)
    const many = parseModels({ data: Array.from({ length: 12 }, (_, i) => ({ id: `custom-chat-${i}` })) })
    expect(selectModels(many, Array.from({ length: 12 }, (_, i) => i + 1).join(','))).toHaveLength(12)
    for (const answer of ['', '1,2,2', '1,2,99', '1,2,3', '0,1,2', '1,2,4,5', '1.0,2,4', 'gpt,claude,gemini'])
      expect(() => selectModels(list(), answer)).toThrow()
  })
  it('supports search, unchanged global numbers, validation errors, refresh and cancellation without generation', async () => {
    const discover = vi.fn(async () => list())
    const write = vi.fn()
    const answers = ['/grok', '4,4,2', 'r', '/清空', '1,2,4']
    const chosen = await chooseModels({
      baseURL: 'https://fixture.invalid/v1',
      credentialEnv: 'ZEN_QUALITY_TEST_KEY',
      discover,
      write,
      ask: async () => answers.shift()!
    })
    expect(chosen.map((model) => model.id)).toEqual([ids[1], ids[2], ids[0]])
    expect(discover).toHaveBeenCalledTimes(2)
    expect(write.mock.calls.flat().join('')).toContain('4. grok-4-7')
    await expect(
      chooseModels({
        baseURL: 'https://fixture.invalid/v1',
        credentialEnv: 'ZEN_QUALITY_TEST_KEY',
        discover,
        write,
        ask: async () => 'q'
      })
    ).rejects.toThrow('已取消')
  })
  it('rejects unsafe endpoint/credential refs before any fetch, even if a key exists', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    for (const url of [
      'http://example.test/v1',
      'https://user:secret@example.test/v1',
      'https://example.test/v1?key=secret'
    ])
      expect(() => providerURL(url)).toThrow()
    await expect(
      fetchModels({ baseURL: 'https://fixture.invalid/v1', credentialEnv: 'PERSONAL_API_KEY' })
    ).rejects.toThrow('引用')
    await expect(
      fetchModels({ baseURL: 'https://fixture.invalid/v1', credentialEnv: 'ZEN_QUALITY_MISSING_KEY' })
    ).rejects.toThrow('本机')
    expect(spy).not.toHaveBeenCalled()
  })
  it('works with one available chat model and refuses a list with no chat models', async () => {
    expect(
      await chooseModels({
        baseURL: 'https://fixture.invalid/v1',
        credentialEnv: 'ZEN_QUALITY_TEST_KEY',
        write: () => {},
        ask: async () => '1',
        discover: async () => list().slice(0, 1)
      })
    ).toHaveLength(1)
    await expect(
      chooseModels({
        baseURL: 'https://fixture.invalid/v1',
        credentialEnv: 'ZEN_QUALITY_TEST_KEY',
        write: () => {},
        ask: async () => '1,2,3',
        discover: async () => list().filter((model) => model.nonChat)
      })
    ).rejects.toThrow('没有可选')
  })
  it('uses only authenticated GET /models, never follows a redirect or prints an upstream secret body', async () => {
    let status = 200
    let calls = 0
    const server = createServer((req, res) => {
      calls++
      expect(req.method).toBe('GET')
      expect(req.url).toBe('/v1/models')
      expect(req.headers.authorization).toBe('Bearer owned-fixture-only')
      if (status !== 200) res.writeHead(status, { location: 'https://never-follow.invalid' }).end('secret error body')
      else res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }))
    })
    await listenOnLoopback(server)
    vi.stubEnv('ZEN_QUALITY_TEST_KEY', 'owned-fixture-only')
    const input = {
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      credentialEnv: 'ZEN_QUALITY_TEST_KEY'
    }
    try {
      expect(await fetchModels(input)).toEqual(list())
      for (const code of [302, 401, 503]) {
        status = code
        await expect(fetchModels(input)).rejects.toThrow(`HTTP ${code}`)
      }
      expect(calls).toBe(4)
      const controller = new AbortController()
      controller.abort()
      await expect(fetchModels({ ...input, signal: controller.signal })).rejects.toThrow('取消')
      expect(calls).toBe(4)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
