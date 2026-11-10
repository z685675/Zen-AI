import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:fs')
const mocks = vi.hoisted(() => ({ data: '', spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../access', () => ({ assertDshPreviewUnlocked: vi.fn() }))
vi.mock('../install', () => ({
  dshDataRoot: () => mocks.data,
  cancelDshPreviewPreparation: async () => {},
  getDshPreviewRuntimeStatus: () => ({ state: 'ready' }),
  getPreparedDshRuntime: vi.fn(),
  prepareDshPreviewRuntime: vi.fn(),
  buildDshEnvironment: vi.fn()
}))

import { forkDshSession, readDshSessionHistory, replaceDshSessionHistory, resetDshSession } from '../runtime'

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.data = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-dsh-history-test-'))
})
afterEach(async () => {
  await fs.rm(mocks.data, { recursive: true, force: true })
})

async function generation(sessionId: string) {
  const root = path.join(mocks.data, 'sessions', createHash('sha256').update(sessionId).digest('hex'))
  const mapping = JSON.parse(await fs.readFile(path.join(root, 'native.json'), 'utf8'))
  return { root, home: path.join(root, mapping.generation), mapping }
}
const events = [
  { type: 'turn/start', seq: 0, data: { turn: 1 } },
  { type: 'user/message', seq: 1, data: { id: 'native-user', source: { kind: 'user' }, content: [] } },
  { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } }
]

describe('DSH native history generation switches', () => {
  it('preserves attachments across clear and database rollback without replaying any side effect', async () => {
    await resetDshSession('source')
    let current = await generation('source')
    await fs.mkdir(path.join(current.home, 'attachments/v1'), { recursive: true })
    await fs.writeFile(path.join(current.home, 'attachments/v1/original-image'), 'immutable-image')
    const original = await replaceDshSessionHistory('source', events)
    await resetDshSession('source')
    expect((await readDshSessionHistory('source')).events).toEqual([])
    const restored = await replaceDshSessionHistory('source', original.events)
    expect(restored.sessionId).not.toBe(original.sessionId)
    expect((await readDshSessionHistory('source')).events).toEqual(events)
    current = await generation('source')
    expect(await fs.readFile(path.join(current.home, 'attachments/v1/original-image'), 'utf8')).toBe('immutable-image')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('forks a closed native prefix and rejects incomplete logs before replacing the active generation', async () => {
    await replaceDshSessionHistory('source', events)
    const copied = await forkDshSession('source', 'target')
    expect(copied.events).toEqual(events)
    const before = (await generation('target')).mapping
    await expect(replaceDshSessionHistory('target', events.slice(0, 2))).rejects.toThrow('closed turn')
    await expect(replaceDshSessionHistory('target', [events[1]])).rejects.toThrow('continuous native prefix')
    expect((await generation('target')).mapping).toEqual(before)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
