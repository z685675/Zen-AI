export type TaskScheduleKind = 'cron' | 'interval' | 'once'

function parseCron(value: string) {
  // Keep the parser loading style aligned with the existing scheduler code.
  const { CronExpressionParser } = require('cron-parser')
  return CronExpressionParser.parse(value)
}

/** Validate a schedule before it is persisted or rescheduled. */
export function validateTaskSchedule(scheduleType: string, scheduleValue: string): void {
  const value = scheduleValue.trim()
  if (!value) throw new Error('Schedule value is required')

  switch (scheduleType as TaskScheduleKind) {
    case 'cron':
      try {
        parseCron(value)
      } catch {
        throw new Error(`Invalid cron expression: ${value}`)
      }
      return
    case 'interval': {
      const minutes = Number(value)
      if (!Number.isInteger(minutes) || minutes <= 0) {
        throw new Error('Interval must be a positive whole number of minutes')
      }
      return
    }
    case 'once': {
      const timestamp = Date.parse(value)
      if (!Number.isFinite(timestamp)) {
        throw new Error(`Invalid one-time schedule: ${value}`)
      }
      return
    }
    default:
      throw new Error(`Unsupported schedule type: ${scheduleType}`)
  }
}

/** Compute the first execution time after validation. */
export function computeInitialTaskRun(scheduleType: string, scheduleValue: string): string | null {
  validateTaskSchedule(scheduleType, scheduleValue)
  const value = scheduleValue.trim()

  switch (scheduleType as TaskScheduleKind) {
    case 'cron':
      return parseCron(value).next().toISOString()
    case 'interval':
      return new Date(Date.now() + Number(value) * 60_000).toISOString()
    case 'once':
      return new Date(value).toISOString()
    default:
      return null
  }
}

export function computeNextCronRun(scheduleValue: string): string {
  validateTaskSchedule('cron', scheduleValue)
  return parseCron(scheduleValue.trim()).next().toISOString()
}
