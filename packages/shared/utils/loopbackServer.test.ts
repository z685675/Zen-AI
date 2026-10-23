import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { Server } from 'node:net'

import { describe, expect, it } from 'vitest'

import { isFetchSafePort, listenOnLoopback } from './loopbackServer'

function fixture(ports: number[], failure?: Error) {
  const events = new EventEmitter()
  let attempts = 0
  let closes = 0
  const server = Object.assign(events, {
    listen: (port: number, host: string) => {
      expect([port, host]).toEqual([0, '127.0.0.1'])
      attempts++
      queueMicrotask(() => events.emit(failure ? 'error' : 'listening', failure))
    },
    address: () => ({ port: ports[Math.min(attempts - 1, ports.length - 1)] }),
    close: (callback: () => void) => {
      closes++
      callback()
    }
  })
  return { server: server as unknown as Server, attempts: () => attempts, closes: () => closes }
}

describe('Fetch-compatible loopback allocation', () => {
  it('rejects forbidden and invalid ports, not just well-known low ports', () => {
    for (const port of [0, -1, 65536, NaN, 10.5, 21, 6000, 6566, 6667, 10080]) expect(isFetchSafePort(port)).toBe(false)
    for (const port of [1024, 3000, 8080, 49152, 65535]) expect(isFetchSafePort(port)).toBe(true)
  })

  it('closes a forbidden socket before rebinding and retains the safe listener', async () => {
    const item = fixture([6667, 10080, 49152])
    expect(await listenOnLoopback(item.server)).toBe(49152)
    expect(item.attempts()).toBe(3)
    expect(item.closes()).toBe(2)
    expect(item.server.listenerCount('error')).toBe(0)
    expect(item.server.listenerCount('listening')).toBe(0)
  })

  it('has a bounded allocation loop and does not swallow bind errors', async () => {
    const unsafe = fixture([6667])
    await expect(listenOnLoopback(unsafe.server)).rejects.toThrow('16 attempts')
    expect(unsafe.attempts()).toBe(16)
    expect(unsafe.closes()).toBe(16)
    const failed = fixture([], new Error('bind denied'))
    await expect(listenOnLoopback(failed.server)).rejects.toThrow('bind denied')
    expect(failed.attempts()).toBe(1)
    expect(failed.server.listenerCount('listening')).toBe(0)
  })

  it('keeps a real HTTP socket bound and reachable by Fetch', async () => {
    const server = createServer((_request, response) => response.end('owned-loopback'))
    const port = await listenOnLoopback(server)
    try {
      expect(server.listening).toBe(true)
      expect(isFetchSafePort(port)).toBe(true)
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('owned-loopback')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
