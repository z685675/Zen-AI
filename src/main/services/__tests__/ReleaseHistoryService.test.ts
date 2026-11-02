import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { ReleaseHistoryData } from '@shared/releaseHistory'
import { net } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ReleaseHistoryService } from '../ReleaseHistoryService'

vi.mock('node:os', async (original) => original())
vi.mock('node:path', async (original) => original())
vi.mock('node:fs', async (original) => original())

const date = '2026-11-01T00:00:00.000Z'
const entry = (version: string, notes = version) => ({ version, notes, releaseDate: date })
const history = (...entries: ReturnType<typeof entry>[]): ReleaseHistoryData => ({
  schemaVersion: 1,
  updatedAt: date,
  entries
})
let directory: string
let cachePath: string
const fetch = vi.mocked(net.fetch)
const response = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'zen-release-history-'))
  cachePath = path.join(directory, 'records', 'history.json')
  fetch.mockReset()
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('local release history', () => {
  it('shows local records immediately without waiting for the network', async () => {
    const service = new ReleaseHistoryService('1.1.79', history(entry('1.1.77')), cachePath, 'Installer preview')
    expect((await service.getSnapshot()).entries.map((item) => item.version)).toEqual(['1.1.79', '1.1.77'])
    expect(fetch).not.toHaveBeenCalled()
    expect((await service.getSnapshot()).entries[0].releaseDate).toBeNull()
  })

  it('persists final edited notes and restores them offline across restarts', async () => {
    const service = new ReleaseHistoryService('1.1.79', history(entry('1.1.77')), cachePath, 'Unedited installer notes')
    fetch.mockResolvedValue(response(history(entry('1.1.79', 'Final published wording'))))
    const online = await service.refresh()
    expect(online.refreshFailed).toBe(false)
    expect(online.entries[0].notes).toBe('Final published wording')
    const cached = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(cached.entries[0].notes).toBe('Final published wording')

    fetch.mockRejectedValue(new Error('offline'))
    const restarted = new ReleaseHistoryService(
      '1.1.79',
      history(entry('1.1.77')),
      cachePath,
      'Unedited installer notes'
    )
    const offline = await restarted.refresh()
    expect(offline.refreshFailed).toBe(true)
    expect(offline.entries[0].notes).toBe('Final published wording')
    expect((await restarted.getSnapshot()).refreshedAt).not.toBeNull()
  })

  it('retains earlier fetched versions when a later response omits them', async () => {
    const service = new ReleaseHistoryService('1.1.79', history(), cachePath, '')
    fetch.mockResolvedValueOnce(response(history(entry('1.1.78'), entry('1.1.79', 'Original'))))
    await service.refresh()
    fetch.mockResolvedValueOnce(response(history(entry('1.1.79', 'Corrected'), entry('1.1.80'))))
    const next = await service.refresh(true)
    expect(next.entries.map((item) => item.version)).toEqual(['1.1.80', '1.1.79', '1.1.78'])
    expect(next.entries[1].notes).toBe('Corrected')
  })

  it('shares concurrent refreshes and throttles automatic retries while allowing a manual retry', async () => {
    let finish!: (value: Response) => void
    fetch.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const service = new ReleaseHistoryService('1.1.79', history(), cachePath, '')
    const one = service.refresh()
    const two = service.refresh(true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    finish(response(history(entry('1.1.79'))))
    await Promise.all([one, two])
    await service.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockResolvedValue(response(history(entry('1.1.79'))))
    await service.refresh(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    () => new Response('not found', { status: 404 }),
    () => new Response('{broken'),
    () => response(history({ ...entry('1.1.80'), releaseDate: 'invalid' })),
    () => response(history(entry('1.1.80-beta.1'))),
    () => new Response('', { headers: { 'content-length': '999999999' } }),
    () => new Response('x'.repeat(5 * 1024 * 1024 + 1))
  ])('preserves local notes and cache when a remote response is invalid', async (invalid) => {
    await mkdir(path.dirname(cachePath), { recursive: true })
    const existing = JSON.stringify(history(entry('1.1.79', 'Saved offline')))
    await writeFile(cachePath, existing)
    fetch.mockResolvedValue(invalid())
    const service = new ReleaseHistoryService('1.1.79', history(), cachePath, '')
    const result = await service.refresh()
    expect(result.refreshFailed).toBe(true)
    expect(result.entries[0].notes).toBe('Saved offline')
    expect(await readFile(cachePath, 'utf8')).toBe(existing)
  })

  it('recovers from a corrupt cache using the bundled archive', async () => {
    await mkdir(path.dirname(cachePath), { recursive: true })
    await writeFile(cachePath, 'broken cache')
    const service = new ReleaseHistoryService('1.1.79', history(entry('1.1.77')), cachePath, '')
    expect((await service.getSnapshot()).entries[0].version).toBe('1.1.77')
  })
})
