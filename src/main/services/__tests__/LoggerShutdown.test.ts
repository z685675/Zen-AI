import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as LoggerModule from '../LoggerService'

const harness = vi.hoisted(() => ({
  finished: vi.fn(),
  logger: { on: vi.fn(), end: vi.fn(), writableEnded: false }
}))
vi.mock('node:stream/promises', () => ({ finished: harness.finished }))
vi.mock('@main/constant', () => ({ isDev: false }))
vi.mock('../DiagnosticEvidenceService', () => ({ captureDiagnosticLog: vi.fn() }))
vi.mock('winston', () => ({
  default: {
    createLogger: () => harness.logger,
    format: { combine: vi.fn(), timestamp: vi.fn(), errors: vi.fn(), json: vi.fn() }
  }
}))
vi.mock('winston-daily-rotate-file', () => ({ default: class {} }))

// main.setup mocks @logger (the same module); exercise its real implementation.
const { loggerService } = await vi.importActual<typeof LoggerModule>('../LoggerService')

beforeEach(() => {
  vi.clearAllMocks()
  harness.finished.mockResolvedValue(undefined)
})

describe('shutdown log flush', () => {
  it('waits for the final transport writes before allowing quit', async () => {
    let flush!: () => void
    harness.finished.mockReturnValueOnce(new Promise<void>((resolve) => (flush = resolve)))
    let complete = false
    const pending = loggerService.finish().then(() => (complete = true))
    const logger = harness.logger
    expect(harness.finished).toHaveBeenCalledExactlyOnceWith(logger, { readable: false, cleanup: true })
    expect(logger.end).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(complete).toBe(false)
    flush()
    await pending
    expect(complete).toBe(true)
  })

  it('preserves a transport failure instead of declaring successful cleanup', async () => {
    harness.finished.mockRejectedValueOnce(new Error('disk write failed'))
    await expect(loggerService.finish()).rejects.toThrow('disk write failed')
  })

  it('still waits for an already-ended logger without ending it again', async () => {
    const logger = harness.logger
    logger.writableEnded = true
    try {
      await loggerService.finish()
      expect(logger.end).not.toHaveBeenCalled()
      expect(harness.finished).toHaveBeenCalledOnce()
    } finally {
      logger.writableEnded = false
    }
  })
})
