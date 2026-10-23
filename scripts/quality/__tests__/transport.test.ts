import { createServer, type Server } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { listenOnLoopback } from '../../../packages/shared/utils/loopbackServer'
import { OpenCodeClient } from '../../../src/main/services/agents/services/opencode/client'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function fixture(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler)
  servers.push(server)
  await listenOnLoopback(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback address')
  return new OpenCodeClient(`http://127.0.0.1:${address.port}`, 'local-fixture-only', '/isolated-workspace')
}

describe('quality loopback runtime transport fault matrix', () => {
  it.each([401, 403, 429, 503, 524])(
    'preserves HTTP %i, never echoes secret bodies or silently retries',
    async (status) => {
      let requests = 0
      const client = await fixture((_req, res) => {
        requests++
        res.writeHead(status, { 'Content-Type': 'text/plain' }).end('sk-private-error-body-do-not-leak')
      })
      await expect(client.request('/session')).rejects.toMatchObject({ status, zenFailureStage: 'agent-runtime' })
      await expect(client.request('/session')).rejects.not.toThrow('private-error-body')
      expect(requests).toBe(2) // two explicit calls, no automatic retry inside either call
    }
  )

  it.each(['', '<html>gateway error</html>', '{"broken":'])(
    'does not treat malformed successful JSON as a valid answer (%j)',
    async (body) => {
      const client = await fixture((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(body))
      await expect(client.request('/session')).rejects.toThrow()
    }
  )

  it('handles fragmented multibyte SSE and coalesced events over actual loopback HTTP', async () => {
    const bytes = Buffer.from(
      'data: {"type":"message.part.delta","properties":{"delta":"中文"}}\r\n\r\ndata: {"type":"session.idle","properties":{}}\n\n'
    )
    const offset = bytes.indexOf(Buffer.from('中')) + 1
    const client = await fixture((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(bytes.subarray(0, offset))
      setImmediate(() => res.end(bytes.subarray(offset)))
    })
    const controller = new AbortController()
    const events = []
    for await (const event of client.events(controller.signal)) {
      events.push(event)
      if (event.type === 'session.idle') break
    }
    expect(events.map((event) => event.type)).toEqual(['message.part.delta', 'session.idle'])
    expect(events[0].properties.delta).toBe('中文')
  })

  it('treats partial output then stream end as an interruption, not final completion', async () => {
    const client = await fixture((_req, res) =>
      res
        .writeHead(200, { 'Content-Type': 'text/event-stream' })
        .end('data: {"type":"message.part.delta","properties":{"delta":"partial"}}\n\n')
    )
    const events = []
    await expect(
      (async () => {
        for await (const event of client.events(new AbortController().signal)) events.push(event)
      })()
    ).rejects.toThrow('disconnected')
    expect(events).toHaveLength(1)
  })

  it('does not count heartbeat-only or malformed frames as a completed task', async () => {
    for (const data of [': heartbeat\n\n', 'data: not-json\n\n']) {
      const observed = []
      const client = await fixture((_req, res) => res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(data))
      await expect(
        (async () => {
          for await (const event of client.events(new AbortController().signal)) observed.push(event)
        })()
      ).rejects.toThrow()
      expect(observed).toHaveLength(0)
    }
  })
})
