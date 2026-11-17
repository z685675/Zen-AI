import { createServer, type Server } from 'node:http'

import { fetch } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'

const dns = vi.hoisted(() => ({ addresses: [] as Array<{ address: string; family: number }> }))
vi.mock('node:dns', () => ({
  lookup: (_host: string, _options: unknown, callback: (...args: any[]) => void) =>
    queueMicrotask(() =>
      callback(
        null,
        dns.addresses.map((entry) => ({ ...entry }))
      )
    )
}))

import { ModelConnectionPool } from '../connection'

const pools: ModelConnectionPool[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()))
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})
async function listen(host: string, handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  return { server, url: `http://model.test:${(server.address() as { port: number }).port}/v1/chat/completions` }
}
function pool() {
  const value = new ModelConnectionPool()
  pools.push(value)
  return value
}

describe('model socket selection before HTTP writes', () => {
  it('prefers IPv4 despite IPv6-first DNS and reuses a connection without retaining request content', async () => {
    dns.addresses = [
      { address: '::1', family: 6 },
      { address: '127.0.0.1', family: 4 }
    ]
    const { server, url } = await listen('127.0.0.1', (_req, res) => res.end('ok'))
    const connected = vi.fn()
    server.on('connection', connected)
    const transport = pool()
    const events = vi.fn()
    for (let n = 0; n < 2; n++) {
      const response = await transport.run(events, () => fetch(url, { dispatcher: transport.agent }))
      expect(await response.text()).toBe('ok')
      // Undici marks the socket idle on the next event-loop turn after EOF.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(connected).toHaveBeenCalledOnce()
    expect(events).toHaveBeenCalledWith(
      'request-write-started',
      expect.objectContaining({
        remoteAddress: '127.0.0.1',
        addressFamily: 'IPv4',
        connectionReused: false
      })
    )
    expect(events).toHaveBeenCalledWith('request-write-started', expect.objectContaining({ connectionReused: true }))
  })

  it('falls back to IPv6 before sending exactly one POST with the original body', async () => {
    dns.addresses = [
      { address: '::1', family: 6 },
      { address: '127.0.0.2', family: 4 }
    ]
    const received: string[] = []
    const { url } = await listen('::1', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      received.push(body)
      res.end('ok')
    })
    const transport = pool()
    const record = vi.fn()
    const response = await transport.run(record, () =>
      fetch(url, {
        dispatcher: transport.agent,
        method: 'POST',
        body: 'PRIVATE_PROMPT',
        headers: { Authorization: 'Bearer PRIVATE_KEY' }
      })
    )
    expect(await response.text()).toBe('ok')
    expect(received).toEqual(['PRIVATE_PROMPT'])
    expect(record).toHaveBeenCalledWith('request-write-started', expect.objectContaining({ addressFamily: 'IPv6' }))
    expect(JSON.stringify(record.mock.calls)).not.toMatch(/PRIVATE_KEY|PRIVATE_PROMPT/)
  })

  it('does not replay a POST when the server disconnects after receiving it', async () => {
    dns.addresses = [{ address: '127.0.0.1', family: 4 }]
    const received: string[] = []
    const { url } = await listen('127.0.0.1', async (req) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      received.push(body)
      req.socket.destroy()
    })
    const transport = pool()
    await expect(
      transport.run(vi.fn(), () =>
        fetch(url, {
          dispatcher: transport.agent,
          method: 'POST',
          body: 'one-generation'
        })
      )
    ).rejects.toThrow()
    expect(received).toEqual(['one-generation'])
  })
})
