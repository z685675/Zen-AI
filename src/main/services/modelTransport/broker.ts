import { isRoutableApiRequest } from '@shared/clientConnections'
import {
  discardResponseBody,
  isManagedModelRequest,
  type ModelTransportChunk,
  type ModelTransportRequest,
  type ModelTransportStart,
  transportError
} from '@shared/modelTransport'

interface ActiveRequest {
  controller: AbortController
  reader?: ReadableStreamDefaultReader<Uint8Array>
  reading: boolean
  idleTimer?: ReturnType<typeof setTimeout>
}

const RESPONSE_IDLE_TIMEOUT_MS = 60_000

/** Pull-based IPC keeps SSE streaming and backpressure without buffering replies. */
export class ModelTransportBroker {
  private owners = new Map<number, Map<string, ActiveRequest>>()

  constructor(private send: (request: ModelTransportRequest, signal: AbortSignal) => Promise<Response>) {}

  async start(owner: number, request: ModelTransportRequest): Promise<ModelTransportStart> {
    let active: ActiveRequest | undefined
    try {
      this.validate(request)
      let requests = this.owners.get(owner)
      if (!requests) this.owners.set(owner, (requests = new Map()))
      if (requests.has(request.id) || requests.size >= 32) throw new Error('Model transport request is already active')
      active = { controller: new AbortController(), reading: false }
      requests.set(request.id, active)
      const response = await this.send(request, active.controller.signal)
      if (active.controller.signal.aborted) {
        discardResponseBody(response)
        active.controller.signal.throwIfAborted()
      }
      active.reader = response.body?.getReader()
      const result: ModelTransportStart = {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        // Decoded response bytes cross IPC; stale compression/length and cookies
        // must not be reapplied by the renderer's synthetic Response.
        headers: Array.from(response.headers.entries()).filter(
          ([name]) =>
            !['content-encoding', 'content-length', 'set-cookie', 'transfer-encoding', 'connection'].includes(name)
        ),
        hasBody: Boolean(active.reader)
      }
      if (active.reader) this.scheduleIdleExpiry(owner, request.id, active)
      else this.remove(owner, request.id, active)
      return result
    } catch (error) {
      if (active && this.owners.get(owner)?.get(request.id) === active) this.cancel(owner, request.id)
      return { ok: false, error: transportError(error) }
    }
  }

  async pull(owner: number, id: string): Promise<ModelTransportChunk> {
    const active = this.owners.get(owner)?.get(id)
    if (!active?.reader) return { error: { name: 'AbortError', message: 'Model request is no longer active' } }
    if (active.reading)
      return { error: { name: 'TypeError', message: 'Concurrent model stream reads are not allowed' } }
    active.reading = true
    clearTimeout(active.idleTimer)
    try {
      const result = await active.reader.read()
      active.controller.signal.throwIfAborted()
      if (result.done) {
        active.reader.releaseLock()
        this.remove(owner, id, active)
        return { done: true }
      }
      this.scheduleIdleExpiry(owner, id, active)
      return { done: false, value: result.value }
    } catch (error) {
      if (this.owners.get(owner)?.get(id) === active) this.cancel(owner, id)
      return { error: transportError(error) }
    } finally {
      active.reading = false
    }
  }

  cancel(owner: number, id: string, reason?: DOMException) {
    const active = this.owners.get(owner)?.get(id)
    if (!active) return
    this.remove(owner, id, active)
    active.controller.abort(reason)
    const reader = active.reader
    void reader
      ?.cancel()
      .catch(() => {})
      .finally(() => reader.releaseLock())
  }

  private scheduleIdleExpiry(owner: number, id: string, active: ActiveRequest) {
    // A pending pull still belongs to a live reader, even during long SSE pauses.
    active.idleTimer = setTimeout(() => {
      if (this.owners.get(owner)?.get(id) === active) this.cancel(owner, id)
    }, RESPONSE_IDLE_TIMEOUT_MS)
    active.idleTimer.unref()
  }

  cancelOwner(owner: number) {
    for (const id of this.owners.get(owner)?.keys() || []) this.cancel(owner, id)
  }

  stop() {
    for (const owner of this.owners.keys()) this.cancelOwner(owner)
  }

  private remove(owner: number, id: string, active: ActiveRequest) {
    clearTimeout(active.idleTimer)
    const requests = this.owners.get(owner)
    if (requests?.get(id) !== active) return
    requests.delete(id)
    if (!requests.size) this.owners.delete(owner)
  }

  private validate(request: ModelTransportRequest) {
    if (
      !request ||
      typeof request.id !== 'string' ||
      !/^[\w-]{1,128}$/.test(request.id) ||
      typeof request.url !== 'string' ||
      typeof request.method !== 'string' ||
      !(isManagedModelRequest(request.url, request.method) || isRoutableApiRequest(request.url, request.method)) ||
      (request.body !== undefined && (typeof request.body !== 'string' || request.method.toUpperCase() !== 'POST')) ||
      (request.body !== undefined && Buffer.byteLength(request.body) > 64 * 1024 * 1024) ||
      !Array.isArray(request.headers) ||
      request.headers.length > 128 ||
      request.headers.some(
        (pair) => !Array.isArray(pair) || pair.length !== 2 || pair.some((value) => typeof value !== 'string')
      )
    ) {
      throw new Error('Invalid managed model request')
    }
    const headers = new Headers(request.headers)
    if (Array.from(headers).some(([name]) => ['host', 'cookie', 'connection', 'content-length'].includes(name)))
      throw new Error('Invalid managed model request headers')
  }
}
