import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertScopedTemp,
  assertTextOnlySummary,
  decodeEvents,
  hasCompletedSummary,
  makePdf
} from '../opencode-attachment-smoke'

async function* chunks(...parts: Array<string | Uint8Array>) {
  for (const part of parts) yield typeof part === 'string' ? Buffer.from(part) : part
}

async function collect(input: AsyncIterable<Uint8Array>, limit?: number) {
  const output: unknown[] = []
  for await (const item of decodeEvents(input, limit)) output.push(item)
  return output
}

describe('native attachment smoke evidence helpers', () => {
  it('decodes fragmented CRLF, multiline data and UTF-8, including coalesced frames', async () => {
    const event = { type: 'test', properties: { text: '路径' } }
    const encoded = Buffer.from(`data: ${JSON.stringify(event)}\r\n\r\n`)
    const split = encoded.indexOf(Buffer.from('路')) + 1
    const output = await collect(
      chunks(
        encoded.subarray(0, split),
        encoded.subarray(split, -3),
        encoded.subarray(-3),
        ': heartbeat\r\n\r\ndata: [DONE]\n\ndata: {"type":"two",\ndata: "properties":{}}\n\n'
      )
    )
    expect(output).toEqual([
      { event, bytes: encoded.length - 4 },
      { event: { type: 'two', properties: {} }, bytes: 43 }
    ])
  })

  it('accepts a fragmented PDF-sized event beyond the old 8-million-character client guard', async () => {
    const frame = `data: ${JSON.stringify({ type: 'message.part.updated', properties: { data: 'A'.repeat(13_200_000) } })}\n\n`
    const output = await collect(chunks(frame.slice(0, 8_100_000), frame.slice(8_100_000)))
    expect(output).toHaveLength(1)
  })

  it('enforces the observer limit on both completed and incomplete frames', async () => {
    await expect(collect(chunks('data: {"properties":"long"}\n\n'), 10)).rejects.toThrow('exceeded')
    await expect(collect(chunks('data: {"properties":"long"}'), 10)).rejects.toThrow('exceeded')
    await expect(collect(chunks('data: {}'))).rejects.toThrow('incomplete frame')
  })

  it('rejects base64/media in summaries but permits exact paths and attachment labels', () => {
    expect(() =>
      assertTextOnlySummary({
        messages: [{ content: '[Attached application/pdf: example.pdf] C:\\docs\\example.pdf' }]
      })
    ).not.toThrow()
    expect(() => assertTextOnlySummary({ content: 'data:application/pdf;base64,QUJD' })).toThrow('base64')
    expect(() => assertTextOnlySummary({ image_url: { url: 'file:///test.png' } })).toThrow('media')
    expect(() => assertTextOnlySummary({ content: 'A'.repeat(1024) })).toThrow('opaque')
  })

  it('does not treat summary=true alone or an errored/empty summary as success', () => {
    const message = { info: { role: 'assistant', summary: true }, parts: [{ type: 'text', text: 'summary' }] }
    expect(hasCompletedSummary([message])).toBe(false)
    expect(hasCompletedSummary([{ ...message, info: { ...message.info, finish: 'stop' } }])).toBe(true)
    expect(
      hasCompletedSummary([{ ...message, info: { ...message.info, finish: 'error', error: { name: 'APIError' } } }])
    ).toBe(false)
    expect(
      hasCompletedSummary([{ info: { ...message.info, finish: 'stop' }, parts: [{ type: 'text', text: '  ' }] }])
    ).toBe(false)
  })

  it('generates the 9.9MB PDF with valid xref offsets and stream length', () => {
    const pdf = makePdf()
    expect(pdf.length).toBeGreaterThan(9_900_000)
    expect(pdf.length).toBeLessThan(9_901_000)
    const text = pdf.toString()
    const start = Number(/startxref\n(\d+)/.exec(text)![1])
    expect(text.slice(start, start + 4)).toBe('xref')
    const offsets = [...text.slice(start).matchAll(/(\d{10}) 00000 n/g)].map((match) => Number(match[1]))
    expect(offsets).toHaveLength(4)
    for (const [index, offset] of offsets.entries()) expect(text.slice(offset, offset + 7)).toBe(`${index + 1} 0 obj`)
    const stream = text.indexOf('stream\n') + 7
    expect(text.slice(stream + 9_900_000, stream + 9_900_000 + 9)).toBe('endstream')
  })

  it('refuses cleanup outside the task-owned temporary path', () => {
    expect(() => assertScopedTemp(path.join(os.tmpdir(), 'zen-opencode-attachments-fixture'))).not.toThrow()
    expect(() => assertScopedTemp(os.tmpdir())).toThrow()
    expect(() => assertScopedTemp(path.join(os.tmpdir(), 'unrelated'))).toThrow()
    expect(() => assertScopedTemp(path.join(os.tmpdir(), 'zen-opencode-attachments-fixture', 'nested'))).toThrow()
  })
})
