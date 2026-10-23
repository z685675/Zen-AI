import { createServer } from 'node:http'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { config } from '../config'
import { ApiServer } from '../server'

vi.mock('../config', () => ({
  config: {
    load: vi.fn(async () => ({ port: 0, host: '127.0.0.1' })),
    reload: vi.fn(async () => ({}))
  }
}))
vi.mock('../app', () => ({ app: (_req: unknown, res: any) => res.end('owned-fixture') }))
vi.mock('../../services/WindowService', () => ({ windowService: { getMainWindow: () => null } }))

beforeEach(() => {
  vi.mocked(config.load).mockReset()
  vi.mocked(config.load).mockResolvedValue({ port: 0, host: '127.0.0.1' } as any)
  vi.mocked(config.reload).mockClear()
})

describe('local API server lifecycle serialization', () => {
  it('starts once under concurrent calls and retains the actual listening server', async () => {
    const server = new ApiServer()
    let release!: () => void
    const ready = new Promise<void>((resolve) => (release = resolve))
    vi.mocked(config.load).mockImplementation(async () => {
      await ready
      return { port: 0, host: '127.0.0.1' } as any
    })
    const first = server.start()
    const second = server.start()
    release()
    try {
      await Promise.all([first, second])
      expect(config.load).toHaveBeenCalledTimes(1)
      expect(server.isRunning()).toBe(true)
    } finally {
      await server.stop()
    }
    expect(server.isRunning()).toBe(false)
  })

  it('orders overlapping restart/stop/start without leaking a listener', async () => {
    const server = new ApiServer()
    try {
      await server.start()
      await Promise.all([server.restart(), server.stop(), server.start()])
      expect(config.reload).toHaveBeenCalledTimes(1)
      expect(server.isRunning()).toBe(true)
    } finally {
      await server.stop()
    }
    expect(server.isRunning()).toBe(false)
  })

  it('does not poison lifecycle or erase another listener after a bind failure', async () => {
    const blocker = createServer((_req, res) => res.end('blocker'))
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const port = (blocker.address() as { port: number }).port
    const server = new ApiServer()
    vi.mocked(config.load).mockResolvedValueOnce({ port, host: '127.0.0.1' } as any)
    try {
      await expect(server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(blocker.listening).toBe(true)
      expect(server.isRunning()).toBe(false)
      await server.start()
      expect(server.isRunning()).toBe(true)
    } finally {
      await server.stop()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})
