import type { Message } from '@renderer/types/newMessage'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createMessageResponseTimer,
  formatMessageDuration,
  formatMessageTimestamp,
  getMessageDisplayTimestamp,
  getMessageTimingStats
} from '../messageTiming'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('response timing', () => {
  it('freezes the first tool activity without waiting for a later text answer', () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const timer = createMessageResponseTimer()
    clock = 2000
    timer.markFirstActivity()
    clock = 20_000
    timer.markFirstActivity()
    clock = 900_000
    timer.markFirstToken('final answer')
    clock = 903_000
    expect(timer.finish('completed')).toMatchObject({ firstTokenMs: 2000, elapsedMs: 903_000 })
  })
  it('does not invent activity after a task already stopped', () => {
    const timer = createMessageResponseTimer()
    timer.finish('cancelled')
    timer.markFirstActivity()
    expect(timer.finish('completed').firstTokenMs).toBeUndefined()
  })
  it('measures the entire round and freezes its first visible token and finish time', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-10-11T01:30:00Z')
    let clock = 100
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const timer = createMessageResponseTimer()
    clock = 500
    timer.markFirstToken('  ')
    clock = 1600
    timer.markFirstToken('thinking')
    clock = 3600
    timer.markFirstToken('answer')
    clock = 8100
    vi.setSystemTime('2026-10-11T01:30:08Z')
    const timing = timer.finish('completed')
    expect(timing).toEqual({
      startedAt: '2026-10-11T01:30:00.000Z',
      finishedAt: '2026-10-11T01:30:08.000Z',
      firstTokenMs: 1500,
      elapsedMs: 8000,
      outcome: 'completed'
    })
    clock = 20_000
    vi.setSystemTime('2026-10-11T01:40:00Z')
    expect(timer.finish('failed')).toBe(timing)
    expect(timing.elapsedMs).toBe(8000)
  })

  it('does not invent a first token for cancellation before any text', () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const timer = createMessageResponseTimer()
    clock = 5000
    expect(timer.finish('cancelled')).toMatchObject({ firstTokenMs: undefined, elapsedMs: 5000, outcome: 'cancelled' })
    timer.markFirstToken('late text')
    expect(timer.finish('completed').firstTokenMs).toBeUndefined()
  })

  it('uses a monotonic duration even if the system clock changes', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-10-11T01:30:00Z')
    let clock = 2000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const timer = createMessageResponseTimer()
    clock = 5000
    vi.setSystemTime('2026-10-11T01:00:00Z')
    expect(timer.finish('completed').elapsedMs).toBe(3000)
  })

  it('preserves the completed timestamp after later message metadata updates', () => {
    const message = {
      role: 'assistant',
      createdAt: '2026-10-11T01:30:00Z',
      updatedAt: '2026-10-11T02:00:00Z',
      providerMetadata: { responseTiming: { finishedAt: '2026-10-11T01:30:08Z' } }
    } as Message
    expect(getMessageDisplayTimestamp(message)).toBe('2026-10-11T01:30:08Z')
    expect(getMessageDisplayTimestamp({ ...message, role: 'user' })).toBe('2026-10-11T01:30:00Z')
  })

  it('shows both submission and response completion timestamps to the second', () => {
    const message = {
      role: 'assistant',
      createdAt: '2026-10-11T09:30:07',
      updatedAt: '2026-10-11T10:00:00',
      providerMetadata: { responseTiming: { finishedAt: '2026-10-11T09:30:59' } }
    } as Message
    expect(formatMessageTimestamp(message)).toBe('10/11 09:30:59')
    expect(formatMessageTimestamp({ ...message, role: 'user' })).toBe('10/11 09:30:07')
  })

  it('uses legacy timestamps when no valid completed timestamp exists', () => {
    const message = { role: 'assistant', createdAt: 'created', updatedAt: 'updated' } as Message
    expect(getMessageDisplayTimestamp(message)).toBe('updated')
    expect(getMessageDisplayTimestamp({ ...message, updatedAt: undefined })).toBe('created')
    expect(
      getMessageDisplayTimestamp({
        ...message,
        providerMetadata: { responseTiming: { finishedAt: 'invalid' } }
      } as Message)
    ).toBe('updated')
  })

  it('adds legacy first-token latency to the streaming duration without double counting new timing', () => {
    const message = { metrics: { time_first_token_millsec: 1500, time_completion_millsec: 2500 } } as Message
    expect(getMessageTimingStats(message)).toMatchObject({ firstTokenMs: 1500, elapsedMs: 4000 })
    expect(
      getMessageTimingStats({
        ...message,
        providerMetadata: { responseTiming: { firstTokenMs: 1000, elapsedMs: 6000, outcome: 'completed' } }
      } as Message)
    ).toMatchObject({ firstTokenMs: 1000, elapsedMs: 6000 })
  })

  it('does not fabricate unknown or invalid timing', () => {
    expect(getMessageTimingStats({} as Message)).toMatchObject({ firstTokenMs: undefined, elapsedMs: undefined })
    expect(formatMessageDuration(undefined)).toBe('—')
    expect(formatMessageDuration(NaN)).toBe('—')
    expect(formatMessageDuration(-1)).toBe('—')
    expect(formatMessageDuration(1250)).toBe('1.25s')
    expect(formatMessageDuration(0)).toBe('0.00s')
  })
})
