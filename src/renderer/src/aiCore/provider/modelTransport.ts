import { isRoutableApiRequest } from '@shared/clientConnections'
import { isManagedModelRequest, type ModelTransportBridge, type ModelTransportError } from '@shared/modelTransport'

const deserializeError = (error: ModelTransportError) =>
  Object.assign(new Error(error.message), { name: error.name, code: error.code })

/** The bridge streams an existing request; it never replays generation on error. */
export function managedModelFetch(
  nativeFetch: typeof fetch,
  getBridge: () => ModelTransportBridge | undefined = () => window.api?.modelTransport
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : undefined
    const method = init?.method || 'GET'
    const bridge = getBridge()
    if (
      !bridge ||
      !url ||
      !(isManagedModelRequest(url, method) || isRoutableApiRequest(url, method)) ||
      (init?.body != null && typeof init.body !== 'string') ||
      init?.credentials === 'include'
    )
      return nativeFetch(input, init)
    const id = crypto.randomUUID()
    const signal = init?.signal
    signal?.throwIfAborted()
    let finished = false
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const finish = () => {
      finished = true
      signal?.removeEventListener('abort', abort)
    }
    const cancel = (reason?: 'timeout') => (reason ? bridge.cancel(id, reason) : bridge.cancel(id)).catch(() => {})
    const abort = () => {
      if (finished) return
      finish()
      void cancel(signal?.reason?.name === 'TimeoutError' ? 'timeout' : undefined)
      streamController?.error(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await bridge.start({
        id,
        url,
        method,
        headers: Array.from(new Headers(init?.headers).entries()),
        ...(typeof init?.body === 'string' ? { body: init.body } : {})
      })
      signal?.throwIfAborted()
      if (!response.ok) throw deserializeError(response.error)
      const body = response.hasBody
        ? new ReadableStream<Uint8Array>(
            {
              start(controller) {
                streamController = controller
              },
              async pull(controller) {
                try {
                  const chunk = await bridge.pull(id)
                  if (finished) return
                  if ('error' in chunk) throw deserializeError(chunk.error)
                  if (chunk.done) {
                    finish()
                    controller.close()
                  } else controller.enqueue(chunk.value)
                } catch (error) {
                  if (finished) return
                  finish()
                  void cancel()
                  controller.error(error)
                }
              },
              cancel() {
                finish()
                return cancel()
              }
            },
            { highWaterMark: 0 }
          )
        : null
      if (!body) finish()
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    } catch (error) {
      if (!finished) {
        finish()
        void cancel()
      }
      throw error
    }
  }
}
