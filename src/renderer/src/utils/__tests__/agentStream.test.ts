import { AiSdkToChunkAdapter } from '@renderer/aiCore/chunk/AiSdkToChunkAdapter'
import { createStreamProcessor } from '@renderer/services/StreamProcessingService'
import { type Chunk, ChunkType } from '@renderer/types/chunk'
import { describe, expect, it, vi } from 'vitest'

import { createSSEReadableStream, withAbortStreamPart } from '../agentStream'
import { isAbortError, serializeError } from '../error'

function bytes(text: string) {
  return new TextEncoder().encode(text)
}

describe('agent SSE error delivery', () => {
  it.each(['\n\n', '\r\n\r\n', ''])(
    'keeps the first native error across fragmented SSE with delimiter %j',
    async (delimiter) => {
      const event = `data: ${JSON.stringify({
        type: 'error',
        error: {
          name: 'ProviderHeaderTimeoutError',
          message: 'Provider response headers timed out after 60000ms',
          code: 'provider_header_timeout',
          zenFailureStage: 'provider-connect',
          cause: { message: 'socket closed' },
          zenTraceId: 'trace-safe'
        }
      })}${delimiter}`
      let offset = 0
      const cancel = vi.fn()
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset < event.length) controller.enqueue(bytes(event.slice(offset, (offset += 3))))
          else if (!delimiter) controller.close()
          else controller.error(new Error('late socket closed'))
        },
        cancel
      })
      const control = new AbortController()
      const chunks: Chunk[] = []
      const onError = vi.fn()
      const onComplete = vi.fn()
      const processor = createStreamProcessor({ onError, onComplete })
      const adapter = new AiSdkToChunkAdapter((chunk) => {
        chunks.push(chunk)
        void processor(chunk)
      })
      const outcome = await adapter
        .processStream(
          {
            fullStream: withAbortStreamPart(createSSEReadableStream(source, control.signal), control.signal),
            text: Promise.resolve('')
          },
          { throwOnError: true }
        )
        .catch((error) => error)
      await processor.drain()
      expect(outcome.message).toContain('headers timed out after 60000ms')
      expect(chunks.filter((chunk) => chunk.type === ChunkType.ERROR)).toHaveLength(1)
      expect(onError).toHaveBeenCalledOnce()
      expect(onComplete).not.toHaveBeenCalled()
      const saved = serializeError(outcome)
      expect(saved).toMatchObject({
        code: 'provider_header_timeout',
        zenFailureStage: 'provider-connect',
        zenTraceId: 'trace-safe'
      })
      expect(saved.cause).toContain('ProviderHeaderTimeoutError')
      expect(saved.cause).toContain('socket closed')
      expect(isAbortError(outcome)).toBe(false)
      expect(source.locked).toBe(false)
    }
  )

  it.each(['[DONE]', ''])(
    'does not turn a partial response followed by %j into a successful finish',
    async (sentinel) => {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes('data: {"type":"text-delta","text":"partial"}\n\n'))
          if (sentinel) controller.enqueue(bytes(`data: ${sentinel}\n\n`))
          controller.close()
        }
      })
      const chunks: Chunk[] = []
      await new AiSdkToChunkAdapter((chunk) => chunks.push(chunk)).processStream({
        fullStream: createSSEReadableStream(source, new AbortController().signal),
        text: Promise.resolve('')
      })
      expect(chunks.some((chunk) => chunk.type === ChunkType.LLM_RESPONSE_COMPLETE)).toBe(false)
      expect(chunks.find((chunk) => chunk.type === ChunkType.ERROR)).toMatchObject({
        error: { message: expect.stringContaining('without a completion signal') }
      })
    }
  )

  it('reports malformed SSE instead of silently falling through to missing completion', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes('data: {bad-json Bearer fixture-secret\n\n'))
        controller.close()
      }
    })
    const chunks: Chunk[] = []
    await new AiSdkToChunkAdapter((chunk) => chunks.push(chunk)).processStream({
      fullStream: createSSEReadableStream(source, new AbortController().signal),
      text: Promise.resolve('')
    })
    expect(chunks).toMatchObject([{ type: ChunkType.ERROR, error: { message: 'Invalid agent SSE event' } }])
    expect(JSON.stringify(chunks)).not.toContain('fixture-secret')
  })

  it('cancels a locked source through its reader and removes its abort listener', async () => {
    const control = new AbortController()
    const remove = vi.spyOn(control.signal, 'removeEventListener')
    const cancel = vi.fn()
    const source = new ReadableStream<Uint8Array>({ cancel })
    const parsed = createSSEReadableStream(source, control.signal)
    await parsed.cancel('consumer stopped')
    expect(cancel).toHaveBeenCalledWith('consumer stopped')
    expect(remove).toHaveBeenCalled()
    expect(source.locked).toBe(false)
  })

  it('emits a distinct abort part for user cancellation', async () => {
    const control = new AbortController()
    const source = new ReadableStream<Uint8Array>()
    const stream = withAbortStreamPart(createSSEReadableStream(source, control.signal), control.signal)
    const reader = stream.getReader()
    const pending = reader.read()
    control.abort()
    await expect(pending).resolves.toMatchObject({ value: { type: 'abort' }, done: false })
    await expect(reader.read()).resolves.toMatchObject({ done: true })
    expect(source.locked).toBe(false)
  })

  it('does not relabel a socket failure as cancellation just because the signal also aborted', async () => {
    const control = new AbortController()
    control.abort()
    const failure = new Error('socket closed')
    const stream = withAbortStreamPart(
      new ReadableStream({
        start(controller) {
          controller.error(failure)
        }
      }),
      control.signal
    )
    await expect(stream.getReader().read()).rejects.toBe(failure)
  })

  it('does not classify a serialized native AbortError as user cancellation', async () => {
    const error = { name: 'AbortError', message: 'Provider request aborted after timeout', code: 'provider_timeout' }
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(`data: ${JSON.stringify({ type: 'error', error })}\n\n`))
        controller.close()
      }
    })
    const outcome = await new AiSdkToChunkAdapter(() => {})
      .processStream(
        {
          fullStream: createSSEReadableStream(source, new AbortController().signal),
          text: Promise.resolve('')
        },
        { throwOnError: true }
      )
      .catch((value) => value)
    expect(isAbortError(outcome)).toBe(false)
    expect(outcome.cause).toMatchObject(error)
  })
})
