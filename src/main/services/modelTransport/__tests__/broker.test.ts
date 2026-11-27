import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelTransportBroker } from '../broker'

const request = {
  id: 'request-1',
  url: 'https://zenai.925636.xyz/v1/chat/completions',
  method: 'POST',
  headers: [['authorization', 'Bearer key']] as [string, string][],
  body: 'original-body'
}
const brokers: ModelTransportBroker[] = []
afterEach(() => {
  brokers.splice(0).forEach((broker) => broker.stop())
  vi.useRealTimers()
})
function broker(send: ConstructorParameters<typeof ModelTransportBroker>[0]) {
  const value = new ModelTransportBroker(send)
  brokers.push(value)
  return value
}

describe('model response streaming broker', () => {
  it('returns headers and initial SSE bytes before the response is complete, preserving backpressure', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    const send = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(value) {
            controller = value
          }
        }),
        {
          headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'x-oneapi-request-id': 'api-1' }
        }
      )
    )
    const value = broker(send)
    const response = await value.start(1, request)
    expect(response).toMatchObject({ ok: true, status: 200, hasBody: true })
    if (!response.ok) throw new Error('missing response')
    expect(response.headers).not.toContainEqual(['content-encoding', 'gzip'])
    const first = value.pull(1, request.id)
    controller.enqueue(encoder.encode('data: 一\n\n'))
    expect(await first).toEqual({ done: false, value: encoder.encode('data: 一\n\n') })
    const next = value.pull(1, request.id)
    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
    expect(await next).toEqual({ done: false, value: encoder.encode('data: [DONE]\n\n') })
    controller.close()
    expect(await value.pull(1, request.id)).toEqual({ done: true })
    expect(send).toHaveBeenCalledOnce()
  })

  it('isolates requests by renderer and aborts an in-flight start without resending', async () => {
    const send = vi.fn(
      (_request, signal: AbortSignal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const value = broker(send)
    const pending = value.start(1, request)
    value.cancel(2, request.id)
    expect(send.mock.calls[0][1].aborted).toBe(false)
    value.cancelOwner(1)
    expect(await pending).toMatchObject({ ok: false, error: { name: 'AbortError' } })
    expect(send).toHaveBeenCalledOnce()
  })

  it('reclaims abandoned responses without cancelling an in-flight SSE read', async () => {
    vi.useFakeTimers()
    const parked = { ...request, id: 'parked' }
    const streaming = { ...request, id: 'streaming' }
    let writer!: ReadableStreamDefaultController<Uint8Array>
    const abandoned = vi.fn()
    const value = broker(
      async ({ id }) =>
        new Response(
          id === parked.id
            ? new ReadableStream({ cancel: abandoned })
            : new ReadableStream({ start: (controller) => (writer = controller) })
        )
    )
    await value.start(1, parked)
    await value.start(1, streaming)
    const waiting = value.pull(1, streaming.id)
    await vi.advanceTimersByTimeAsync(65_000)
    expect(abandoned).toHaveBeenCalledOnce()
    expect(await value.start(1, parked)).toMatchObject({ ok: true })

    const chunk = new Uint8Array([1])
    writer.enqueue(chunk)
    expect(await waiting).toEqual({ done: false, value: chunk })
    await vi.advanceTimersByTimeAsync(65_000)
    expect(await value.pull(1, streaming.id)).toHaveProperty('error.name', 'AbortError')
  })

  it('does not let duplicate request IDs cancel the existing stream and cancels on window teardown', async () => {
    const cancel = vi.fn()
    const value = broker(async () => new Response(new ReadableStream({ cancel })))
    expect(await value.start(1, request)).toMatchObject({ ok: true })
    expect(await value.start(1, request)).toMatchObject({ ok: false })
    value.cancelOwner(1)
    expect(cancel).toHaveBeenCalledOnce()
    expect(await value.pull(1, request.id)).toHaveProperty('error')
  })

  it.each([
    { url: 'https://evil.example/v1/chat/completions' },
    { url: 'https://zenai.925636.xyz/api/image-studio/tasks' },
    { headers: [['cookie', 'private-cookie']] },
    { headers: [['Host', 'other-host']] },
    { method: 'GET' },
    { body: 123 },
    { id: '../request' }
  ])('rejects invalid requests before sending: %j', async (change) => {
    const send = vi.fn()
    const value = broker(send)
    expect(await value.start(1, { ...request, ...change } as typeof request)).toMatchObject({ ok: false })
    expect(send).not.toHaveBeenCalled()
  })
})
