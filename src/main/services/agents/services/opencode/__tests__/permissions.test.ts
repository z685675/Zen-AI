import { afterEach, describe, expect, it, vi } from 'vitest'

import { watchOpenCodePermissions } from '../permissions'

afterEach(() => vi.useRealTimers())

describe('native pending permission recovery', () => {
  function fixture() {
    vi.useFakeTimers()
    const request = vi.fn().mockResolvedValue([])
    const onPermission = vi.fn()
    const onError = vi.fn()
    const controller = new AbortController()
    let unfinished = false
    const dispose = watchOpenCodePermissions({
      client: { request },
      sessionId: 'native',
      signal: controller.signal,
      hasUnfinishedTools: () => unfinished,
      onPermission,
      onError
    })
    return {
      request,
      onPermission,
      onError,
      controller,
      dispose,
      startTool: () => {
        unfinished = true
      }
    }
  }
  it('does not poll a model-only wait and recovers only this session while a tool is unfinished', async () => {
    const f = fixture()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(f.request).not.toHaveBeenCalled()
    f.startTool()
    const permission = { id: 'per-write', sessionID: 'native', permission: 'edit', tool: { callID: 'write' } }
    f.request.mockResolvedValue([permission, { ...permission, sessionID: 'another' }])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(f.request).toHaveBeenCalledWith('/permission', 'GET', undefined, expect.any(AbortSignal))
    expect(f.onPermission).toHaveBeenCalledExactlyOnceWith(permission)
    f.dispose()
  })
  it('never overlaps inspections or approves anything itself', async () => {
    const f = fixture()
    f.startTool()
    let resolve!: (value: unknown[]) => void
    f.request.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    await vi.advanceTimersByTimeAsync(12_000)
    expect(f.request).toHaveBeenCalledTimes(1)
    resolve([])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.onPermission).not.toHaveBeenCalled()
    f.dispose()
  })
  it('cancels an in-flight inspection and ignores stale responses after disposal', async () => {
    const f = fixture()
    f.startTool()
    let resolve!: (value: unknown[]) => void
    f.request.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    await vi.advanceTimersByTimeAsync(3_000)
    const signal = f.request.mock.calls[0][3] as AbortSignal
    f.dispose()
    expect(signal.aborted).toBe(true)
    resolve([{ id: 'per-write', sessionID: 'native' }])
    await vi.advanceTimersByTimeAsync(6_000)
    expect(f.onPermission).not.toHaveBeenCalled()
    expect(f.request).toHaveBeenCalledTimes(1)
  })
  it('does not replay a task after transient local inspection failures and stops on cancellation', async () => {
    const f = fixture()
    f.startTool()
    const error = new Error('local inspection unavailable')
    f.request.mockRejectedValueOnce(error)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(f.onError).toHaveBeenCalledExactlyOnceWith(error)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(f.request).toHaveBeenCalledTimes(2)
    f.controller.abort('user stopped')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(f.request).toHaveBeenCalledTimes(2)
    f.dispose()
  })
})
