import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenCodeClient } from '../client'

afterEach(() => vi.unstubAllGlobals())
describe('OpenCode HTTP/SSE client', () => {
  it('receives the reported 9,875,510-byte PDF event across network chunks and continues to the final answer', async () => {
    const pdf = Buffer.alloc(9_875_510, 65).toString('base64')
    const attachment = {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          state: { attachments: [{ mime: 'application/pdf', url: `data:application/pdf;base64,${pdf}` }] }
        }
      }
    }
    const bytes = Buffer.from(
      `data: ${JSON.stringify(attachment)}\r\n\r\ndata: {"type":"session.idle","properties":{}}\r\n\r\n`
    )
    let offset = 0
    let cancelled = false
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(stream) {
                if (offset >= bytes.length) return
                stream.enqueue(bytes.subarray(offset, offset + 16_381))
                offset += 16_381
              },
              cancel() {
                cancelled = true
              }
            })
          )
      )
    )
    const signal = new AbortController()
    const events = []
    for await (const event of new OpenCodeClient('http://127.0.0.1:1', 'password', '/workspace').events(
      signal.signal
    )) {
      events.push(event)
      if (event.type === 'session.idle') break
    }
    expect(events).toHaveLength(2)
    expect(events[0].properties.part.state.attachments[0].url.length).toBe(pdf.length + 28)
    expect(cancelled).toBe(true)
  })
  it('stops promptly when cancelled even if buffered events are still available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'data: {"type":"server.connected","properties":{}}\n\ndata: {"type":"later","properties":{}}\n\n'
          )
      )
    )
    const signal = new AbortController()
    const events = []
    for await (const event of new OpenCodeClient('http://127.0.0.1:1', 'password', '/workspace').events(
      signal.signal
    )) {
      events.push(event)
      signal.abort()
    }
    expect(events).toHaveLength(1)
  })
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
