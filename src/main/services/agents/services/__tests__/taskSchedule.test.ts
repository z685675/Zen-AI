import { describe, expect, it } from 'vitest'

import { computeInitialTaskRun, validateTaskSchedule } from '../taskSchedule'

describe('scheduled task schedule validation', () => {
  it('accepts cron and positive interval schedules', () => {
    expect(() => validateTaskSchedule('cron', '*/15 * * * *')).not.toThrow()
    expect(() => validateTaskSchedule('interval', '30')).not.toThrow()
  })

  it('rejects malformed or unsafe schedules before persistence', () => {
    expect(() => validateTaskSchedule('cron', 'not a cron')).toThrow('Invalid cron expression')
    expect(() => validateTaskSchedule('interval', '0')).toThrow('positive whole number')
    expect(() => validateTaskSchedule('once', 'not-a-date')).toThrow('Invalid one-time schedule')
  })

  it('computes a future first run for interval tasks and keeps one-time timestamps', () => {
    const before = Date.now()
    const intervalRun = computeInitialTaskRun('interval', '5')
    expect(new Date(intervalRun!).getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000)

    const once = '2027-03-26T08:00:00.000Z'
    expect(computeInitialTaskRun('once', once)).toBe(once)
  })
})
