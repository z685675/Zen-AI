import { describe, expect, it } from 'vitest'

import { OPENCODE_EVENT_MAX_BYTES, OpenCodeEventParser } from '../eventParser'

const frame = (text = '你好') => `data: ${JSON.stringify({ type: 'test', properties: { text } })}\n\n`

describe('OpenCode bounded incremental SSE framing', () => {
  it('ignores an initial UTF-8 BOM even when its bytes are fragmented', () => {
    const parser = new OpenCodeEventParser()
    const bytes = Buffer.from(`\uFEFF${frame()}`)
    expect([...bytes].flatMap((byte) => [...parser.push(new Uint8Array([byte]))])).toEqual([
      { type: 'test', properties: { text: '你好' } }
    ])
  })
  it.each(['\n', '\r\n', '\r'])('handles %j delimiters split at every byte', (separator) => {
    const parser = new OpenCodeEventParser()
    const bytes = Buffer.from(
      ': heartbeat\nevent: message\ndata: {"type":"test",\ndata: "properties":{"text":"你好"}}\n\n'.replaceAll(
        '\n',
        separator
      ) + frame('next').replaceAll('\n', separator)
    )
    const events = [...bytes].flatMap((byte) => [...parser.push(new Uint8Array([byte]))])
    expect(events).toEqual([
      { type: 'test', properties: { text: '你好' } },
      { type: 'test', properties: { text: 'next' } }
    ])
  })

  it('handles many independent files without applying the budget to their combined size', () => {
    const bytes = Buffer.from(frame('x'.repeat(300)))
    const parser = new OpenCodeEventParser(bytes.length)
    for (let file = 0; file < 100; file++) {
      expect([...parser.push(bytes)]).toHaveLength(1)
    }
  })

  it.each([1, 7, 256])('enforces the same byte budget with %i-byte chunks', (chunkSize) => {
    const bytes = Buffer.from(frame('私'.repeat(60)))
    const parser = new OpenCodeEventParser(128)
    expect(() => {
      for (let index = 0; index < bytes.length; index += chunkSize) {
        ;[...parser.push(bytes.subarray(index, index + chunkSize))]
      }
    }).toThrow('transport byte budget')
  })

  it('accepts the exact budget and rejects even a complete oversized frame in one chunk', () => {
    const bytes = Buffer.from(frame())
    expect([...new OpenCodeEventParser(bytes.length).push(bytes)]).toHaveLength(1)
    expect(() => [...new OpenCodeEventParser(bytes.length - 1).push(bytes)]).toThrow('transport byte budget')
    expect(OPENCODE_EVENT_MAX_BYTES).toBe(64 * 1024 * 1024)
  })

  it('does not emit unfinished events, control frames or [DONE]', () => {
    const parser = new OpenCodeEventParser()
    expect([...parser.push(Buffer.from(': ping\n\ndata: [DONE]\n\nid: 1\n\n'))]).toEqual([])
    expect([...parser.push(Buffer.from(frame().slice(0, -1)))]).toEqual([])
    expect([...parser.push(Buffer.from('\n'))]).toHaveLength(1)
  })

  it.each(['private-attachment-secret', '{"type":"event","properties":null}'])(
    'reports malformed data without leaking payload: %s',
    (data) => {
      expect(() => [...new OpenCodeEventParser().push(Buffer.from(`data: ${data}\n\n`))]).toThrow(
        'OpenCode event stream returned an invalid event'
      )
    }
  )
})
