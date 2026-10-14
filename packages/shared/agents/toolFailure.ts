import { diagnosticText } from '../diagnostics'

export const ASSISTANT_TOOL_FAILURE_CODES = [
  'cancelled',
  'permission',
  'missing_file',
  'file_busy',
  'dependency',
  'runtime',
  'validation',
  'invalid_input',
  'rate_limit',
  'timeout',
  'network',
  'unknown'
] as const

export type AssistantToolFailureCode = (typeof ASSISTANT_TOOL_FAILURE_CODES)[number]
export type AssistantToolFailure = {
  kind: 'zen-assistant-tool-failure'
  version: 1
  code: AssistantToolFailureCode
  tool: string
  details: string
  // Guidance never grants permission to retry an action or install a dependency.
  automatic_retry: false
}

/** Classify observed tool errors only. Never probe a service or change task control flow. */
export function createAssistantToolFailure(tool: string, error: unknown, cancelled = false): AssistantToolFailure {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown tool error'
  const errorCode = error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : ''
  let code: AssistantToolFailureCode = 'unknown'
  if (
    cancelled ||
    /^(AbortError|CancellationError)$/.test(error instanceof Error ? error.name : '') ||
    /\baborted\b/i.test(message)
  )
    code = 'cancelled'
  else if (
    /EACCES|EPERM/.test(errorCode) ||
    /not approved|permission denied|outside authorized|outside allowed|not permitted|plan mode|symbolic link|unauthorized/i.test(
      message
    )
  )
    code = 'permission'
  else if (
    /EEXIST|EBUSY/.test(errorCode) ||
    /already exists|file changed|being used by another process|file is locked/i.test(message)
  )
    code = 'file_busy'
  else if (
    tool === 'python_execute' &&
    /(?:ModuleNotFoundError|ImportError):\s*(?:No module named|cannot import name)/i.test(message)
  )
    code = 'dependency'
  else if (
    /managed python.*(?:not|missing|unavailable)|python runtime.*(?:not|missing|unavailable)|runtime.*not ready|no supported office renderer/i.test(
      message
    )
  )
    code = 'runtime'
  else if (/ENOENT/.test(errorCode) || /no such file|file not found|does not exist|missing file/i.test(message))
    code = 'missing_file'
  else if (
    /delivery validation|failed.*validation|formula cached result|circular formula|uncached formula|visible content missing|formula.*requires.*result|invalid.*ooxml|office quality/i.test(
      message
    )
  )
    code = 'validation'
  else if (/\b429\b|rate.?limit|quota exceeded|too many requests|search.*cooling/i.test(message)) code = 'rate_limit'
  else if (/ETIMEDOUT/.test(errorCode) || /timed? ?out|timeout/i.test(message)) code = 'timeout'
  else if (
    /ECONN|ENOTFOUND|EAI_AGAIN/.test(errorCode) ||
    /fetch failed|failed to fetch|network error|connection refused|socket hang up/i.test(message)
  )
    code = 'network'
  else if (
    /required|must be|must provide|provide exactly|unsupported|invalid param|invalid input|invalid worksheet|at most|exceeds.*limit/i.test(
      message
    )
  )
    code = 'invalid_input'
  return {
    kind: 'zen-assistant-tool-failure',
    version: 1,
    code,
    tool,
    details: diagnosticText(message),
    automatic_retry: false
  }
}

/** Accept only a bounded, versioned product envelope, not arbitrary text that mentions an error. */
export function readAssistantToolFailure(value: unknown, depth = 0): AssistantToolFailure | undefined {
  if (depth > 4) return undefined
  if (typeof value === 'string') {
    if (value.length > 40_000) return undefined
    try {
      return readAssistantToolFailure(JSON.parse(value), depth + 1)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  if (Array.isArray(item.content)) {
    for (const part of item.content.slice(0, 8)) {
      if (part?.type !== 'text') continue
      const failure = readAssistantToolFailure(part.text, depth + 1)
      if (failure) return failure
    }
    return undefined
  }
  for (const key of ['failure', 'error', 'message']) {
    if (item[key] && item[key] !== value) {
      const failure = readAssistantToolFailure(item[key], depth + 1)
      if (failure) return failure
    }
  }
  if (
    item.kind !== 'zen-assistant-tool-failure' ||
    item.version !== 1 ||
    item.automatic_retry !== false ||
    !ASSISTANT_TOOL_FAILURE_CODES.includes(item.code as AssistantToolFailureCode) ||
    typeof item.tool !== 'string' ||
    item.tool.length > 200 ||
    typeof item.details !== 'string'
  )
    return undefined
  return {
    kind: item.kind,
    version: 1,
    code: item.code as AssistantToolFailureCode,
    tool: item.tool,
    details: diagnosticText(item.details),
    automatic_retry: false
  }
}
