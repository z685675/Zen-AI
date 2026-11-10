import fs from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

function loadDriver() {
  const require = createRequire(import.meta.url)
  const clientRequire = createRequire(require.resolve('@libsql/client'))
  const source = fs.readFileSync(clientRequire.resolve('libsql'), 'utf8')
  const handles: object[] = []
  const exitHandlers: Array<() => void> = []
  const entries = new Map<object, { handle: object; guard: object }>()
  let finalize: (value: unknown) => void = () => {}
  const unregister = vi.fn((token: object) => entries.delete(token))
  const native = {
    databaseOpen: vi.fn(() => {
      const handle = { id: handles.length }
      handles.push(handle)
      return handle
    }),
    databasePrepareSync: vi.fn(function (this: object, query: string) {
      return { connection: this, query }
    }),
    databaseClose: vi.fn(),
    databaseInTransaction: vi.fn(() => false)
  }
  class Registry {
    constructor(callback: (value: unknown) => void) {
      finalize = callback
    }
    register(target: object, value: { handle: object; guard: object }, token: object) {
      expect(token).toBe(target)
      entries.set(token, value)
    }
    unregister = unregister
  }
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    process: {
      env: {},
      once: (event: string, handler: () => void) => {
        expect(event).toBe('exit')
        exitHandlers.push(handler)
      }
    },
    FinalizationRegistry: Registry,
    require: (name: string) => {
      if (name === '@neon-rs/load') return { currentTarget: () => 'win32-x64-msvc' }
      if (name === 'detect-libc') return { familySync: () => undefined, GLIBC: 'glibc' }
      if (name === '@libsql/win32-x64-msvc') return native
      if (name === './sqlite-error') return class SqliteError extends Error {}
      throw new Error(`Unexpected driver dependency: ${name}`)
    }
  })
  const Database = module.exports as new (path: string) => { close(): void; open: boolean }
  return { Database, native, handles, entries, finalize, unregister, exitHandlers }
}

describe('libsql native connection lifetime patch', () => {
  it('retains an unexecuted guard through native close and makes repeated close harmless', () => {
    const { Database, native, handles, entries, unregister } = loadDriver()
    const db = new Database(':memory:')
    const lifetime = entries.get(db)!
    expect(lifetime.guard).toMatchObject({ connection: handles[0], query: 'SELECT 1' })
    native.databaseClose.mockImplementation(function (this: unknown) {
      expect(this).toBe(handles[0])
      expect(entries.get(db)).toBe(lifetime)
    })
    db.close()
    db.close()
    expect(native.databaseClose).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledWith(db)
    expect(db.open).toBe(false)
  })

  it('releases a collected transaction connection once and excludes it from exit cleanup', () => {
    const { Database, native, entries, finalize, exitHandlers } = loadDriver()
    const db = new Database(':memory:')
    const lifetime = entries.get(db)!
    finalize(lifetime)
    finalize(lifetime)
    exitHandlers[0]()
    expect(native.databaseClose).toHaveBeenCalledOnce()
  })

  it('keeps failed explicit closes retryable, propagates the error and unregisters only on success', () => {
    const { Database, native, unregister } = loadDriver()
    const db = new Database(':memory:')
    native.databaseClose.mockImplementationOnce(() => {
      throw new Error('native close failed')
    })
    expect(() => db.close()).toThrow('native close failed')
    expect(db.open).toBe(true)
    expect(unregister).not.toHaveBeenCalled()
    db.close()
    expect(db.open).toBe(false)
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('retains failed GC cleanup for exit retry and still closes other connections', () => {
    const { Database, native, entries, finalize, exitHandlers } = loadDriver()
    const abandoned = new Database(':memory:')
    new Database(':memory:')
    native.databaseClose.mockImplementationOnce(() => {
      throw new Error('native close failed')
    })
    expect(() => finalize(entries.get(abandoned))).not.toThrow()
    expect(() => exitHandlers[0]()).not.toThrow()
    expect(native.databaseClose).toHaveBeenCalledTimes(3)
    exitHandlers[0]()
    expect(native.databaseClose).toHaveBeenCalledTimes(3)
  })

  it('uses one exit hook per driver and skips connections already closed explicitly', () => {
    const { Database, native, exitHandlers } = loadDriver()
    const first = new Database(':memory:')
    new Database(':memory:')
    new Database(':memory:')
    first.close()
    expect(exitHandlers).toHaveLength(1)
    exitHandlers[0]()
    expect(native.databaseClose).toHaveBeenCalledTimes(3)
  })
})
