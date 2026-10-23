import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')

import { runDocumentProcess } from '../assistantDocumentProcess'

const temporary: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('document native process isolation', () => {
  it('uses binary IPC, waits for cleanup and reaps the child before returning', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'zen-document-process-'))
    temporary.push(directory)
    const marker = path.join(directory, 'closed.txt')
    const result = await runDocumentProcess<{ pid: number; text: string; buffer: boolean }>(
      `setTimeout(() => require('node:fs').writeFileSync(workerData.marker, 'closed'), 50);
       return { pid: process.pid, text: workerData.data.toString('utf8'), buffer: Buffer.isBuffer(workerData.data) };`,
      { data: Buffer.from('owned 文档'), marker },
      'Test'
    )
    expect(result.text).toBe('owned 文档')
    expect(result.buffer).toBe(true)
    expect(result.pid).not.toBe(process.pid)
    expect(await fs.readFile(marker, 'utf8')).toBe('closed')
    expect(() => process.kill(result.pid, 0)).toThrow()
  })

  it('rejects crashes and missing results without crashing or accepting an earlier result', async () => {
    await expect(runDocumentProcess('process.exit(23)', {}, 'Test')).rejects.toThrow('exit 23')
    await expect(runDocumentProcess('process.exit(0)', {}, 'Test')).rejects.toThrow('parser stopped')
    await expect(
      runDocumentProcess('setTimeout(() => process.exit(7), 50); return { ok: true }', {}, 'Test')
    ).rejects.toThrow('exit 7')
    await expect(runDocumentProcess('throw new Error("corrupt document")', {}, 'Test')).rejects.toThrow(
      'corrupt document'
    )
  })

  it('does not inherit credentials, proxies, or Node preload options', async () => {
    vi.stubEnv('ZEN_QUALITY_SELECTED_KEY', 'owned-secret')
    vi.stubEnv('HTTPS_PROXY', 'http://owned.invalid:1234')
    vi.stubEnv('NODE_OPTIONS', '--require=/owned/must-not-load.cjs')
    const result = await runDocumentProcess(
      `return { key: process.env.ZEN_QUALITY_SELECTED_KEY, proxy: process.env.HTTPS_PROXY, preload: process.env.NODE_OPTIONS }`,
      {},
      'Test'
    )
    expect(result).toEqual({ key: undefined, proxy: undefined, preload: undefined })
  })

  it('cancels running work and work that posted a result without exiting', async () => {
    for (const source of ['while (true) {}', 'setInterval(() => {}, 1000); return { ok: true }']) {
      const controller = new AbortController()
      const pending = runDocumentProcess(source, {}, 'Test', controller.signal)
      const failed = expect(pending).rejects.toThrow('cancelled')
      await new Promise((resolve) => setTimeout(resolve, 100))
      controller.abort()
      await failed
    }
    const controller = new AbortController()
    controller.abort()
    await expect(runDocumentProcess('return 1', {}, 'Test', controller.signal)).rejects.toThrow('cancelled')
  })

  it('enforces the deadline even if a parser posted an error but retained handles', async () => {
    vi.useFakeTimers()
    const pending = runDocumentProcess('setInterval(() => {}, 1000); throw new Error("corrupt")', {}, 'Test')
    const failed = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15_000)
    await failed
  })
})
