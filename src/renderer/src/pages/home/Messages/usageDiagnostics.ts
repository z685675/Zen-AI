import type { OpenCodeTurnDiagnostics } from '@shared/agents/opencodeDiagnostics'

/** Native cache defaults cannot establish that the upstream reported zero. */
export function getReportedCacheCoverage(data: OpenCodeTurnDiagnostics) {
  const expected = data.performance.upstreamRequests
  const complete = expected > 0 && data.observedRequests === expected && data.incompleteRequests === 0
  const readsComplete = complete && data.cacheReadReports === expected
  const rateComplete = readsComplete && data.inputReports === expected
  const { input, cacheRead } = data.usage
  const consistent = input !== undefined && cacheRead !== undefined && cacheRead <= input
  return {
    readsComplete,
    rate: rateComplete && consistent && input > 0 ? cacheRead / input : undefined,
    inconsistent: rateComplete && !consistent,
    partial: !complete || data.inputReports !== expected || data.outputReports !== expected || !readsComplete
  }
}
