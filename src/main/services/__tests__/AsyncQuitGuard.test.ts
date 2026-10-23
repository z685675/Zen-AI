import { describe, expect, it, vi } from 'vitest'

import { createAsyncQuitGuard, runQuitCleanup } from '../AsyncQuitGuard'

describe('async native shutdown', () => {
  it('records the exact cleanup stage and elapsed time, including failures', async () => {
    const onStep = vi.fn()
    const failure = new Error('native close failed')
    await expect(
      runQuitCleanup(
        [
          { name: 'producer', stop: () => {} },
          {
            name: 'storage',
            stop: () => {
              throw failure
            }
          }
        ],
        vi.fn(),
        onStep
      )
    ).rejects.toThrow('Application service cleanup failed')
    expect(onStep.mock.calls.map(([name, state]) => [name, state])).toEqual([
      ['producer', 'started'],
      ['producer', 'completed'],
      ['storage', 'started'],
      ['storage', 'failed']
    ])
    expect(onStep.mock.calls.every(([, , duration]) => Number.isFinite(duration) && duration >= 0)).toBe(true)
  })
  it('stops every producer before storage even if earlier cleanup fails', async () => {
    const calls: string[] = []
    const onError = vi.fn()
    const fail = new Error('service failed to stop')
    await expect(
      runQuitCleanup(
        ['automation', 'channels', 'api-server', 'database'].map((name) => ({
          name,
          stop: async () => {
            calls.push(name)
            if (name === 'channels') throw fail
          }
        })),
        onError
      )
    ).rejects.toThrow('Application service cleanup failed')
    expect(calls).toEqual(['automation', 'channels', 'api-server', 'database'])
    expect(onError).toHaveBeenCalledExactlyOnceWith('channels', fail)
  })
  it('holds quit until cleanup resolves, does not duplicate cleanup, then permits quit', async () => {
    let release!: () => void
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const quit = vi.fn()
    const onError = vi.fn()
    const guard = createAsyncQuitGuard({ cleanup, quit, onError })
    const event = { preventDefault: vi.fn() }
    guard(event)
    guard(event)
    await Promise.resolve()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    const final = { preventDefault: vi.fn() }
    guard(final)
    expect(final.preventDefault).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
  it('reports cleanup failure and timeout and allows a bounded final quit', async () => {
    for (const cleanup of [
      async () => {
        throw new Error('cleanup failed')
      },
      () => new Promise<void>(() => {})
    ]) {
      const quit = vi.fn()
      const onError = vi.fn()
      const guard = createAsyncQuitGuard({ cleanup, quit, onError, timeoutMs: 5 })
      guard({ preventDefault: vi.fn() })
      await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
      expect(onError).toHaveBeenCalledTimes(1)
      expect(quit).toHaveBeenCalledWith(expect.any(Error))
    }
  })
  it('reports a hung producer as a failed quit instead of pretending storage was closed', async () => {
    const databaseClose = vi.fn()
    const quit = vi.fn()
    const onError = vi.fn()
    const guard = createAsyncQuitGuard({
      cleanup: () =>
        runQuitCleanup(
          [
            { name: 'producer', stop: () => new Promise<void>(() => {}) },
            { name: 'database', stop: databaseClose }
          ],
          vi.fn()
        ),
      quit,
      onError,
      timeoutMs: 5
    })
    guard({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(databaseClose).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Application cleanup timed out' }))
    expect(quit).toHaveBeenCalledWith(expect.objectContaining({ message: 'Application cleanup timed out' }))
  })
})
