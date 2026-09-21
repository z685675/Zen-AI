import type { TextStreamPart } from 'ai'

export class AgentRuntimeNoOutputTimeoutError extends Error {
  override name = 'AgentRuntimeNoOutputTimeoutError'
}

export class AgentDeepResearchTimeoutError extends Error {
  override name = 'AgentDeepResearchTimeoutError'
}

export function shouldFallbackRuntime(error: Error, abortController: AbortController): boolean {
  if (abortController.signal.aborted || error.name === 'AbortError') return false
  if (error.name === 'AgentDeepResearchTimeoutError') return false
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

/**
 * Determines whether a running agent can be restarted from a local checkpoint.
 *
 * This is intentionally separate from runtime selection fallback. A runtime
 * fallback is only safe before any visible output; a transport recovery may
 * happen after tools have already run, so the caller must start a fresh turn
 * with a checkpoint instead of replaying the original session blindly.
 */
export function isRecoverableAgentTransportError(error: Error, abortController: AbortController): boolean {
  if (abortController.signal.aborted || error.name === 'AbortError') return false

  const message = `${error.name} ${error.message}`.toLowerCase()
  const nonRecoverablePatterns = [
    /abort|cancel/,
    /api[_ -]?key|auth|unauthorized|forbidden|\b401\b|\b403\b/,
    /invalid request|invalid model|provider or model not found|no accessible paths/,
    /context window|context_length_exceeded|maximum context|too many tokens/,
    /permission denied|access denied/,
    /tool .*failed|tool_error|mcp.*error/
  ]
  if (nonRecoverablePatterns.some((pattern) => pattern.test(message))) return false

  return [
    /failed to fetch|fetch failed|network|econn|enotfound|etimedout|socket|proxy/,
    /connection|connection reset|connection refused|premature eof|unexpected end/,
    /stream (closed|interrupted|ended|reset)|upstream stream interrupted/,
    /\b429\b|\b502\b|\b503\b|\b504\b|\b524\b|bad gateway|service unavailable|gateway timeout/,
    /timed out|timeout/
  ].some((pattern) => pattern.test(message))
}

export function isRuntimeBootstrapChunk(chunk: TextStreamPart<Record<string, any>>): boolean {
  if (chunk.type === 'start' || chunk.type === 'start-step') return true
  if (chunk.type !== 'raw') return false

  const rawType = (chunk.rawValue as { type?: unknown } | undefined)?.type
  return rawType === 'init' || rawType === 'codex_thread_started'
}
