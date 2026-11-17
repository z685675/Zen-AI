import { BUILTIN_MODEL_CAPACITY_CATALOG, getModelCatalogCapacity, setModelCapacityCatalog } from '@shared/modelCapacity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureModelCapacityCatalog } from '../ModelCapacityCatalogService'

const originalApi = window.api
const get = vi.fn()
let clock = Date.now()
const snapshot = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  models: { 'test-lab/new-chat-model': { context: 600_000, output: 32_000 } }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime((clock += 120_000))
  get.mockReset()
  Object.defineProperty(window, 'api', { configurable: true, value: { modelCapacity: { get } } })
})
afterEach(() => {
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
  setModelCapacityCatalog(BUILTIN_MODEL_CAPACITY_CATALOG)
  vi.useRealTimers()
})

describe('AI chat capacity catalog bridge', () => {
  it('applies the main-process snapshot and avoids one IPC call per question', async () => {
    get.mockResolvedValue(snapshot)
    await ensureModelCapacityCatalog()
    expect(getModelCatalogCapacity('new-chat-model')?.context).toBe(600_000)
    await ensureModelCapacityCatalog()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('shares an in-flight read between concurrent chats', async () => {
    let finish!: (value: typeof snapshot) => void
    get.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const first = ensureModelCapacityCatalog()
    const second = ensureModelCapacityCatalog()
    expect(get).toHaveBeenCalledTimes(1)
    finish(snapshot)
    await Promise.all([first, second])
    expect(getModelCatalogCapacity('new-chat-model')?.output).toBe(32_000)
  })

  it('keeps offline capacities when IPC fails or returns malformed data', async () => {
    get.mockRejectedValueOnce(new Error('IPC unavailable'))
    await expect(ensureModelCapacityCatalog()).resolves.toBeUndefined()
    expect(getModelCatalogCapacity('gpt-6.1-sol')).toBeDefined()
    vi.advanceTimersByTime(60_001)
    get.mockResolvedValueOnce({ error: 'unavailable' })
    await expect(ensureModelCapacityCatalog()).resolves.toBeUndefined()
    expect(getModelCatalogCapacity('gpt-6.1-sol')).toBeDefined()
  })
})
