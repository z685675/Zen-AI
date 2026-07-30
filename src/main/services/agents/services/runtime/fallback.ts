import type { TextStreamPart } from 'ai'

export class AgentRuntimeNoOutputTimeoutError extends Error {
  override name = 'AgentRuntimeNoOutputTimeoutError'
}

export function shouldFallbackRuntime(error: Error, abortController: AbortController): boolean {
  if (abortController.signal.aborted || error.name === 'AbortError') return false
  if (error.name === 'AgentRuntimeNoOutputTimeoutError') return true

  const message = error.message.toLowerCase()
  const nonFallbackPatterns = [
    /abort|cancel/,
    /api[_ -]?key|auth|unauthorized|forbidden|\b401\b|\b403\b/,
    /quota|balance|credit|billing|rate.?limit|\b429\b/,
    /network|econn|enotfound|etimedout|socket|proxy/,
    /no accessible paths|invalid model id|provider or model not found/
  ]

  return !nonFallbackPatterns.some((pattern) => pattern.test(message))
}

export function isRuntimeBootstrapChunk(chunk: TextStreamPart<Record<string, any>>): boolean {
  if (chunk.type === 'start' || chunk.type === 'start-step') return true
  if (chunk.type !== 'raw') return false

  const rawType = (chunk.rawValue as { type?: unknown } | undefined)?.type
  return rawType === 'init' || rawType === 'codex_thread_started'
}
