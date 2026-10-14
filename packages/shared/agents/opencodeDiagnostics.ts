/** Content-free observations. These are reported usage, never a bill or estimate. */
export type ReportedUsage = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

export type OpenCodeUsageObservation = {
  usage: ReportedUsage
  complete: boolean
  format: 'openai' | 'responses' | 'anthropic' | 'gemini' | 'unknown'
}

export type OpenCodeTurnDiagnostics = {
  version: 1
  providerId: string
  modelId: string
  usage: ReportedUsage
  observedRequests: number
  reportedRequests: number
  inputReports: number
  outputReports: number
  cacheReadReports: number
  cacheWriteReports: number
  incompleteRequests: number
  performance: {
    outcome: 'completed' | 'failed' | 'cancelled'
    totalMs: number
    preparationMs: number | null
    upstreamRequests: number
    upstreamHeaderWaitMs: number
    upstreamRequestMs: number
    retryEvents: number
    toolCalls: number
    completedToolObservedMs: number
    unfinishedTools: number
  }
}

export const isReportedTokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function readOpenCodeTurnDiagnostics(value: unknown): OpenCodeTurnDiagnostics | undefined {
  if (!value || typeof value !== 'object') return undefined
  const data = value as OpenCodeTurnDiagnostics
  if (
    data.version !== 1 ||
    typeof data.providerId !== 'string' ||
    typeof data.modelId !== 'string' ||
    data.providerId.length > 256 ||
    data.modelId.length > 256 ||
    !data.usage ||
    !data.performance
  )
    return undefined
  const counts = [
    data.observedRequests,
    data.reportedRequests,
    data.inputReports,
    data.outputReports,
    data.cacheReadReports,
    data.cacheWriteReports,
    data.incompleteRequests
  ]
  if (!counts.every(isReportedTokenCount) || counts.slice(1).some((count) => count > data.observedRequests))
    return undefined
  if (typeof data.usage !== 'object' || Array.isArray(data.usage)) return undefined
  const usage: ReportedUsage = {}
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) {
    const count = data.usage[field]
    if (count === undefined) continue
    if (!isReportedTokenCount(count)) return undefined
    usage[field] = count
  }
  const perf = data.performance
  if (
    !['completed', 'failed', 'cancelled'].includes(perf.outcome) ||
    ![
      perf.totalMs,
      perf.upstreamRequests,
      perf.upstreamHeaderWaitMs,
      perf.upstreamRequestMs,
      perf.retryEvents,
      perf.toolCalls,
      perf.completedToolObservedMs,
      perf.unfinishedTools
    ].every(isReportedTokenCount) ||
    (perf.preparationMs !== null && !isReportedTokenCount(perf.preparationMs))
  )
    return undefined
  // Only numeric statistics and explicitly selected identifiers cross into
  // persisted message metadata; stray response content/credentials are dropped.
  return {
    version: 1,
    providerId: data.providerId,
    modelId: data.modelId,
    usage,
    observedRequests: data.observedRequests,
    reportedRequests: data.reportedRequests,
    inputReports: data.inputReports,
    outputReports: data.outputReports,
    cacheReadReports: data.cacheReadReports,
    cacheWriteReports: data.cacheWriteReports,
    incompleteRequests: data.incompleteRequests,
    performance: {
      outcome: perf.outcome,
      totalMs: perf.totalMs,
      preparationMs: perf.preparationMs,
      upstreamRequests: perf.upstreamRequests,
      upstreamHeaderWaitMs: perf.upstreamHeaderWaitMs,
      upstreamRequestMs: perf.upstreamRequestMs,
      retryEvents: perf.retryEvents,
      toolCalls: perf.toolCalls,
      completedToolObservedMs: perf.completedToolObservedMs,
      unfinishedTools: perf.unfinishedTools
    }
  }
}
