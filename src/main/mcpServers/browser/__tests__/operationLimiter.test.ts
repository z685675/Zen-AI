import { describe, expect, it } from 'vitest'

import { BrowserOperationLimiter, BrowserOperationQueueTimeoutError } from '../operationLimiter'

describe('BrowserOperationLimiter', () => {
  it('keeps concurrent browser operations within the configured limit', async () => {
    const limiter = new BrowserOperationLimiter(2, 1000)
    let active = 0
    let peak = 0

    const operation = async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return 'ok'
    }

    await Promise.all(Array.from({ length: 6 }, () => limiter.run(operation)))

    expect(peak).toBe(2)
  })

  it('fails queued work instead of waiting indefinitely', async () => {
    const limiter = new BrowserOperationLimiter(1, 5)
    let release!: () => void
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = limiter.run(async () => {
      await blocker
      return 'first'
    })
    const queued = limiter.run(async () => 'second')

    await expect(queued).rejects.toBeInstanceOf(BrowserOperationQueueTimeoutError)
    release()
    await expect(first).resolves.toBe('first')
  })

  it('continues draining the queue after an operation fails', async () => {
    const limiter = new BrowserOperationLimiter(1, 1000)
    const failed = limiter.run(async () => {
      throw new Error('failed')
    })
    const next = limiter.run(async () => 'recovered')

    await expect(failed).rejects.toThrow('failed')
    await expect(next).resolves.toBe('recovered')
  })
})
