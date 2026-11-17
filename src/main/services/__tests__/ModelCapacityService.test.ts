import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  BUILTIN_MODEL_CAPACITY_CATALOG,
  getModelCatalogCapacity,
  MODEL_CAPACITY_ENDPOINT,
  setModelCapacityCatalog
} from '@shared/modelCapacity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), getPath: vi.fn() }))
vi.unmock('node:os')
vi.mock('electron', () => ({ app: { getPath: mocks.getPath }, net: { fetch: mocks.fetch } }))

import { ModelCapacityService } from '../ModelCapacityService'

let directory: string
const raw = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  models: { 'test-lab/new-model': { context: 600_000, input: 500_000, output: 32_000 } }
}
const response = () => new Response(JSON.stringify(raw), { headers: { 'Content-Type': 'application/json' } })
const cachePath = () => path.join(directory, 'Data', 'ModelCapacity', 'catalog.json')

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-capacity-'))
  mocks.getPath.mockReturnValue(directory)
  mocks.fetch.mockReset().mockRejectedValue(new Error('offline'))
})
afterEach(async () => {
  setModelCapacityCatalog(BUILTIN_MODEL_CAPACITY_CATALOG)
  if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('zen-capacity-'))
    await fs.rm(directory, { recursive: true, force: true })
})

describe('capacity metadata background refresh', () => {
  it('returns offline data immediately while deduplicating a slow public fetch', async () => {
    let finish!: (value: Response) => void
    mocks.fetch.mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)))
    const service = new ModelCapacityService()
    const snapshot = await service.getSnapshot()
    expect(snapshot).toBe(BUILTIN_MODEL_CAPACITY_CATALOG)
    expect(await service.getSnapshot()).toBe(snapshot)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    const pending = service.refresh()
    finish(response())
    await pending
    expect(getModelCatalogCapacity('new-model')?.context).toBe(600_000)
    const [url, options] = mocks.fetch.mock.calls[0]
    expect(url).toBe(MODEL_CAPACITY_ENDPOINT)
    expect(options.headers).toEqual({ Accept: 'application/json' })
  })

  it('persists a validated update and reuses it on restart without fetching again while fresh', async () => {
    mocks.fetch.mockResolvedValue(response())
    const service = new ModelCapacityService()
    await service.getSnapshot()
    await service.refresh()
    expect(JSON.parse(await fs.readFile(cachePath(), 'utf8')).models['test-lab/new-model']).toEqual(
      raw.models['test-lab/new-model']
    )
    mocks.fetch.mockClear()
    const restarted = new ModelCapacityService()
    expect((await restarted.getSnapshot()).models['test-lab/new-model'].input).toBe(500_000)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('retains valid cached data when an update is an API error and throttles failed fetches', async () => {
    const cached = {
      schemaVersion: 1,
      updatedAt: '2020-01-01T00:00:00Z',
      models: { 'test-lab/existing': { context: 80_000 } }
    }
    await fs.mkdir(path.dirname(cachePath()), { recursive: true })
    await fs.writeFile(cachePath(), JSON.stringify(cached))
    mocks.fetch.mockResolvedValue(new Response('{"error":"not a model catalog"}'))
    const service = new ModelCapacityService()
    expect(await service.getSnapshot()).toEqual(cached)
    await service.refresh()
    expect(await service.getSnapshot()).toEqual(cached)
    expect(JSON.parse(await fs.readFile(cachePath(), 'utf8'))).toEqual(cached)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('falls back from a corrupt cache and unavailable network without rejecting the task', async () => {
    await fs.mkdir(path.dirname(cachePath()), { recursive: true })
    await fs.writeFile(cachePath(), 'not json')
    const service = new ModelCapacityService()
    expect(await service.getSnapshot()).toBe(BUILTIN_MODEL_CAPACITY_CATALOG)
    await expect(service.refresh()).resolves.toBeUndefined()
    expect(await service.getSnapshot()).toBe(BUILTIN_MODEL_CAPACITY_CATALOG)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })
})
