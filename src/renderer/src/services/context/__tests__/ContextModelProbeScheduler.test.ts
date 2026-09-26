import { afterEach, describe, expect, it, vi } from 'vitest'

import { ContextModelProbeScheduler } from '../ContextModelProbeScheduler'

describe('ContextModelProbeScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a model probe at its exact recovery deadline', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const scheduler = new ContextModelProbeScheduler()
    const probe = vi.fn()

    scheduler.schedule('provider:model-a', 301_000, probe)
    vi.advanceTimersByTime(299_999)
    expect(probe).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('reschedules changed deadlines and ignores a cancelled timer', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const scheduler = new ContextModelProbeScheduler()
    const staleProbe = vi.fn()
    const currentProbe = vi.fn()

    scheduler.schedule('provider:model-a', 301_000, staleProbe)
    scheduler.schedule('provider:model-a', 601_000, currentProbe)
    vi.advanceTimersByTime(300_000)
    expect(staleProbe).not.toHaveBeenCalled()
    expect(currentProbe).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300_000)

    expect(currentProbe).toHaveBeenCalledTimes(1)
  })

  it('deduplicates identical deadlines and clears timers for removed models', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const scheduler = new ContextModelProbeScheduler()
    const retainedProbe = vi.fn()
    const removedProbe = vi.fn()

    scheduler.schedule('provider:model-a', 301_000, retainedProbe)
    scheduler.schedule('provider:model-a', 301_000, retainedProbe)
    scheduler.schedule('provider:model-b', 301_000, removedProbe)
    scheduler.retain(new Set(['provider:model-a']))
    vi.advanceTimersByTime(300_000)

    expect(retainedProbe).toHaveBeenCalledTimes(1)
    expect(removedProbe).not.toHaveBeenCalled()
  })
})
