import { addAbortController, removeAbortController } from './abortController'

type RequestEntry = {
  token: symbol
  controller: AbortController
  abortKey: string
  abort: () => void
}

const activeRequests = new Map<string, RequestEntry>()

/**
 * Creates a request-scoped lifecycle for a streamed response.
 *
 * A user message may have more than one response (for example, multi-model
 * mentions), so the request id and the abort-map key are intentionally
 * separate. The request id protects the response from stale writes while the
 * abort key keeps the existing Stop button behaviour intact.
 */
export const createRequestLifecycle = (requestId: string, abortKey = requestId) => {
  const controller = new AbortController()
  const token = Symbol(requestId)
  const abort = () => controller.abort()
  const previous = activeRequests.get(requestId)
  const entry: RequestEntry = { token, controller, abortKey, abort }

  // A regenerated response with the same message id supersedes the old
  // request. Publish the new token before aborting the old request so its
  // abort callback cannot mutate the new response.
  activeRequests.set(requestId, entry)
  if (previous) {
    previous.controller.abort()
    removeAbortController(previous.abortKey, previous.abort)
  }

  addAbortController(abortKey, abort)

  return {
    signal: controller.signal,
    /** True while this request is still the latest request for its message. */
    isCurrent: () => activeRequests.get(requestId)?.token === token,
    /** True while this request is current and has not been cancelled. */
    isActive: () => activeRequests.get(requestId)?.token === token && !controller.signal.aborted,
    dispose: () => {
      removeAbortController(abortKey, abort)
      if (activeRequests.get(requestId)?.token === token) {
        activeRequests.delete(requestId)
      }
    }
  }
}

export const getActiveRequestCount = () => activeRequests.size

export const clearRequestLifecycles = () => {
  for (const entry of activeRequests.values()) {
    entry.controller.abort()
    removeAbortController(entry.abortKey, entry.abort)
  }
  activeRequests.clear()
}
