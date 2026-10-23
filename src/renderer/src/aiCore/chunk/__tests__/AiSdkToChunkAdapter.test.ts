import type { Chunk } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'
import { describe, expect, it, vi } from 'vitest'

import { AiSdkToChunkAdapter } from '../AiSdkToChunkAdapter'

vi.mock('../handleToolCallChunk', () => ({
  ToolCallChunkHandler: class {
    handleToolCall = vi.fn()
    handleToolResult = vi.fn()
  }
}))

async function adapt(parts: unknown[]) {
  const chunks: Chunk[] = []
  const adapter = new AiSdkToChunkAdapter((chunk) => chunks.push(chunk), [], true)
  await adapter.processStream({
    fullStream: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part)
        controller.close()
      }
    }),
    text: Promise.resolve('')
  })
  return chunks
}

const finish = { type: 'finish', finishReason: 'stop', totalUsage: {} }

describe('AI SDK response terminal state', () => {
  it.each(['error-part', 'reader-rejection'])(
    'does not publish agent success before a late %s after finish',
    async (kind) => {
      const chunks: Chunk[] = []
      let controller!: ReadableStreamDefaultController<any>
      const adapter = new AiSdkToChunkAdapter((chunk) => chunks.push(chunk))
      const pending = adapter.processStream(
        {
          fullStream: new ReadableStream({
            start(value) {
              controller = value
              value.enqueue({ type: 'text-delta', text: 'partial' })
              value.enqueue(finish)
            }
          }),
          text: Promise.resolve('')
        },
        { throwOnError: true }
      )
      const outcome = pending.catch((error) => error)
      await vi.waitFor(() => expect(chunks.some((chunk) => chunk.type === ChunkType.TEXT_DELTA)).toBe(true))
      const failure = new Error('late completion failed')
      if (kind === 'error-part') {
        controller.enqueue({ type: 'error', error: failure })
        controller.close()
      } else controller.error(failure)
      expect((await outcome).message).toBe('late completion failed')
      expect(chunks.filter((chunk) => chunk.type === ChunkType.ERROR)).toHaveLength(1)
      expect(chunks.some((chunk) => chunk.type === ChunkType.LLM_RESPONSE_COMPLETE)).toBe(false)
    }
  )

  it('renders a rejected reader as one sanitized failure and rejects strict agent callers', async () => {
    const chunks: Chunk[] = []
    const failure = Object.assign(new Error('socket closed Bearer fixture-secret'), {
      code: 'ECONNRESET',
      cause: { apiKey: 'fixture-secret' }
    })
    await expect(
      new AiSdkToChunkAdapter((chunk) => chunks.push(chunk)).processStream(
        {
          fullStream: new ReadableStream({
            start(controller) {
              controller.error(failure)
            }
          }),
          text: Promise.resolve('')
        },
        { throwOnError: true }
      )
    ).rejects.toMatchObject({ message: 'socket closed Bearer [REDACTED]' })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ type: ChunkType.ERROR, error: { cause: { code: 'ECONNRESET' } } })
    expect(JSON.stringify(chunks)).not.toContain('fixture-secret')
  })

  it.each([
    [finish],
    [{ type: 'text-delta', text: '  \n' }, { type: 'text-end' }, finish],
    [{ type: 'reasoning-delta', text: 'thinking' }, finish]
  ])('reports empty or reasoning-only responses as errors', async (...parts) => {
    const chunks = await adapt(parts)
    expect(chunks.find((chunk) => chunk.type === ChunkType.ERROR)).toMatchObject({
      error: { message: expect.stringContaining('empty response') }
    })
    expect(chunks.some((chunk) => chunk.type === ChunkType.LLM_RESPONSE_COMPLETE)).toBe(false)
  })

  it('retains the provider error instead of accepting a later finish', async () => {
    const chunks = await adapt([
      { type: 'error', error: new Error('status_code=500, upstream error: do request failed') },
      finish
    ])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      type: ChunkType.ERROR,
      error: { message: expect.stringContaining('status_code=500') }
    })
  })

  it('does not turn a partial answer followed by failure into success', async () => {
    const chunks = await adapt([
      { type: 'text-delta', text: 'partial' },
      { type: 'error', error: new Error('connection failed') },
      finish
    ])
    expect(chunks.some((chunk) => chunk.type === ChunkType.TEXT_DELTA)).toBe(true)
    expect(chunks.some((chunk) => chunk.type === ChunkType.ERROR)).toBe(true)
    expect(chunks.some((chunk) => chunk.type === ChunkType.LLM_RESPONSE_COMPLETE)).toBe(false)
  })

  it('rejects an abrupt EOF and a provider error finish', async () => {
    for (const parts of [
      [{ type: 'text-delta', text: 'partial' }],
      [
        { type: 'text-delta', text: 'partial' },
        { ...finish, finishReason: 'error' }
      ]
    ]) {
      const chunks = await adapt(parts)
      expect(chunks.some((chunk) => chunk.type === ChunkType.ERROR)).toBe(true)
      expect(chunks.some((chunk) => chunk.type === ChunkType.LLM_RESPONSE_COMPLETE)).toBe(false)
    }
  })

  it.each([
    [{ type: 'text-delta', text: '完整回答' }, { type: 'text-end' }, finish],
    [{ type: 'text-end', providerMetadata: { text: { value: '完整回答' } } }, finish],
    [{ type: 'tool-call', toolCallId: 'tool', toolName: 'read', input: {} }, finish],
    [{ type: 'file', file: { mediaType: 'image/png', base64: 'fixture' } }, finish]
  ])('preserves successful text, tool and media responses', async (...parts) => {
    const chunks = await adapt(parts)
    expect(chunks.some((chunk) => chunk.type === ChunkType.ERROR)).toBe(false)
    expect(chunks.filter((chunk) => chunk.type === ChunkType.LLM_RESPONSE_COMPLETE)).toHaveLength(1)
  })
})
