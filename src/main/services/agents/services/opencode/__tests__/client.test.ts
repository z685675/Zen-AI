import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenCodeClient } from '../client'

afterEach(() => vi.unstubAllGlobals())
describe('OpenCode HTTP/SSE client', () => {
  it('parses CRLF across byte boundaries and multibyte Chinese text', async () => {
    const encoder = new TextEncoder()
    const bytes = encoder.encode(
      'data: {"type":"server.connected","properties":{}}\r\n\r\ndata: {"type":"test","properties":{"text":"你好"}}\r\n\r\n'
    )
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(stream) {
                for (const byte of bytes) stream.enqueue(new Uint8Array([byte]))
                stream.close()
              }
            })
          )
      )
    )
    const events = []
    for await (const event of new OpenCodeClient('http://127.0.0.1:1', 'password', '/workspace').events(
      controller.signal
    )) {
      events.push(event)
      if (events.length === 2) controller.abort()
    }
    expect(events[1]).toMatchObject({ properties: { text: '你好' } })
  })
  it('treats event EOF as a failure, not task completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(''))
    )
    const iterate = async () => {
      for await (const event of new OpenCodeClient('http://127.0.0.1:1', 'password', '/workspace').events(
        new AbortController().signal
      )) {
        expect(event).toBeDefined()
      }
    }
    await expect(iterate()).rejects.toThrow('disconnected')
  })
  it('does not echo credentials or provider response bodies in local HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('private API-key', { status: 401 }))
    )
    await expect(new OpenCodeClient('http://127.0.0.1:1', 'password', '/workspace').request('/config')).rejects.toThrow(
      'HTTP 401'
    )
  })
})
