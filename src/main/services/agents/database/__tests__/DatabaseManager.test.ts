import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DatabaseManager as DatabaseManagerClass } from '../DatabaseManager'

const harness = vi.hoisted(() => ({
  createClient: vi.fn(),
  runMigrations: vi.fn(),
  runDataMigrations: vi.fn()
}))
vi.mock('@libsql/client', () => ({ createClient: harness.createClient }))
vi.mock('@main/constant', () => ({ isDev: true }))
vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => false), mkdirSync: vi.fn() } }))
vi.mock('drizzle-orm/libsql', () => ({ drizzle: vi.fn(() => ({ kind: 'mock-database' })) }))
vi.mock('../schema', () => ({}))
vi.mock('../MigrationService', () => ({
  MigrationService: class {
    runMigrations = harness.runMigrations
  }
}))
vi.mock('../DataMigrationService', () => ({
  DataMigrationService: class {
    runDataMigrations = harness.runDataMigrations
  }
}))

let DatabaseManager: typeof DatabaseManagerClass

function pending() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.createClient.mockImplementation(() => ({ close: vi.fn() }))
  harness.runMigrations.mockResolvedValue(undefined)
  harness.runDataMigrations.mockResolvedValue(undefined)
  ;({ DatabaseManager } = await import('../DatabaseManager'))
})

describe('assistant native database lifecycle', () => {
  it('shares one connection and migration between concurrent first callers', async () => {
    const migration = pending()
    harness.runMigrations.mockReturnValueOnce(migration.promise)
    const callers = Array.from({ length: 8 }, () => DatabaseManager.getInstance())
    expect(harness.createClient).toHaveBeenCalledOnce()
    expect(harness.runDataMigrations).not.toHaveBeenCalled()
    migration.resolve()
    const instances = await Promise.all(callers)
    expect(new Set(instances).size).toBe(1)
    expect(instances[0].isInitialized()).toBe(true)
    expect(harness.runMigrations).toHaveBeenCalledOnce()
    expect(harness.runDataMigrations).toHaveBeenCalledOnce()
    await DatabaseManager.close()
  })

  it('cleans up a shared failed initialization once and allows a clean retry', async () => {
    harness.runMigrations.mockRejectedValueOnce(new Error('migration failed'))
    const callers = await Promise.allSettled([DatabaseManager.getInstance(), DatabaseManager.getInstance()])
    expect(callers.every((result) => result.status === 'rejected')).toBe(true)
    expect(harness.createClient).toHaveBeenCalledOnce()
    expect(harness.createClient.mock.results[0].value.close).toHaveBeenCalledOnce()
    const next = await DatabaseManager.getInstance()
    expect(next.isInitialized()).toBe(true)
    expect(harness.createClient).toHaveBeenCalledTimes(2)
    await DatabaseManager.close()
  })

  it('waits for in-flight initialization before closing and prevents a late orphan connection', async () => {
    const migration = pending()
    harness.runMigrations.mockReturnValueOnce(migration.promise)
    const opening = expect(DatabaseManager.getInstance()).rejects.toMatchObject({ code: 'assistant_database_closing' })
    const closing = DatabaseManager.close()
    const anotherClose = DatabaseManager.close()
    await expect(DatabaseManager.getInstance()).rejects.toHaveProperty('code', 'assistant_database_closing')
    expect(harness.createClient.mock.results[0].value.close).not.toHaveBeenCalled()
    migration.resolve()
    await Promise.all([opening, closing, anotherClose])
    expect(harness.createClient.mock.results[0].value.close).toHaveBeenCalledOnce()
    expect((await DatabaseManager.getInstance()).isInitialized()).toBe(true)
    expect(harness.createClient).toHaveBeenCalledTimes(2)
    await DatabaseManager.close()
  })

  it('closes exactly once, invalidates stale references, and supports reopening after restore', async () => {
    const old = await DatabaseManager.getInstance()
    const client = await old.getClient()
    await Promise.all([DatabaseManager.close(), DatabaseManager.close()])
    await DatabaseManager.close()
    expect(client.close).toHaveBeenCalledOnce()
    expect(old.isInitialized()).toBe(false)
    expect(() => old.getDatabase()).toThrow('not open')
    await expect(old.getClient()).rejects.toThrow('not open')
    expect(await DatabaseManager.getInstance()).not.toBe(old)
    await DatabaseManager.close()
  })

  it('does not open a database just to shut down and prevents subsequent reopening', async () => {
    await DatabaseManager.shutdown()
    await DatabaseManager.shutdown()
    expect(harness.createClient).not.toHaveBeenCalled()
    await expect(DatabaseManager.getInstance()).rejects.toHaveProperty('code', 'assistant_database_closing')
  })

  it('holds shutdown for initialization and never reopens after the connection is released', async () => {
    const migration = pending()
    harness.runMigrations.mockReturnValueOnce(migration.promise)
    const opening = expect(DatabaseManager.getInstance()).rejects.toHaveProperty('code', 'assistant_database_closing')
    const shutdown = DatabaseManager.shutdown()
    await expect(DatabaseManager.getInstance()).rejects.toHaveProperty('code', 'assistant_database_closing')
    migration.resolve()
    await Promise.all([opening, shutdown])
    await DatabaseManager.shutdown()
    expect(harness.createClient).toHaveBeenCalledOnce()
    expect(harness.createClient.mock.results[0].value.close).toHaveBeenCalledOnce()
    await expect(DatabaseManager.getInstance()).rejects.toHaveProperty('code', 'assistant_database_closing')
  })

  it('handles failed initialization during shutdown without closing the native client twice', async () => {
    harness.runMigrations.mockRejectedValueOnce(new Error('migration failed'))
    const opening = expect(DatabaseManager.getInstance()).rejects.toThrow('migration failed')
    await Promise.all([opening, DatabaseManager.shutdown()])
    expect(harness.createClient.mock.results[0].value.close).toHaveBeenCalledOnce()
  })

  it('propagates native close errors so a restore cannot replace a still-open database', async () => {
    const instance = await DatabaseManager.getInstance()
    const client = await instance.getClient()
    vi.mocked(client.close).mockImplementationOnce(() => {
      throw new Error('native close failed')
    })
    await expect(DatabaseManager.close()).rejects.toThrow('native close failed')
    expect(() => instance.getDatabase()).toThrow('not open')
    await expect(DatabaseManager.close()).rejects.toThrow('native close failed')
    await expect(DatabaseManager.shutdown()).rejects.toThrow('native close failed')
    await expect(DatabaseManager.getInstance()).rejects.toHaveProperty('code', 'assistant_database_close_failed')
    expect(client.close).toHaveBeenCalledOnce()
    expect(harness.createClient).toHaveBeenCalledOnce()
  })

  it('also blocks reopening when cleanup of a failed initialization cannot close its native handle', async () => {
    const close = vi.fn(() => {
      throw new Error('failed-init close failed')
    })
    harness.createClient.mockReturnValueOnce({ close })
    harness.runMigrations.mockRejectedValueOnce(new Error('migration failed'))
    await expect(DatabaseManager.getInstance()).rejects.toThrow('migration failed')
    await expect(DatabaseManager.getInstance()).rejects.toHaveProperty('code', 'assistant_database_close_failed')
    await expect(DatabaseManager.close()).rejects.toThrow('failed-init close failed')
    expect(close).toHaveBeenCalledOnce()
    expect(harness.createClient).toHaveBeenCalledOnce()
  })

  it('propagates native cleanup failure to a shutdown already waiting on failed initialization', async () => {
    const close = vi.fn(() => {
      throw new Error('failed-init close failed')
    })
    harness.createClient.mockReturnValueOnce({ close })
    harness.runMigrations.mockRejectedValueOnce(new Error('migration failed'))
    await Promise.all([
      expect(DatabaseManager.getInstance()).rejects.toThrow('migration failed'),
      expect(DatabaseManager.shutdown()).rejects.toThrow('failed-init close failed')
    ])
    expect(close).toHaveBeenCalledOnce()
    await expect(DatabaseManager.close()).rejects.toThrow('failed-init close failed')
  })
})
