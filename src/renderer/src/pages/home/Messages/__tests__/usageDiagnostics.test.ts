import type { OpenCodeTurnDiagnostics } from '@shared/agents/opencodeDiagnostics'
import { describe, expect, it } from 'vitest'

import { getReportedCacheCoverage } from '../usageDiagnostics'

const fixture = {
  usage: { input: 200, cacheRead: 150 },
  observedRequests: 2,
  inputReports: 2,
  outputReports: 2,
  cacheReadReports: 2,
  incompleteRequests: 0,
  performance: { upstreamRequests: 2 }
} as OpenCodeTurnDiagnostics
describe('cache coverage and rate', () => {
  it('calculates whole-turn rate from complete input/read counters without cache-write duplication', () => {
    expect(getReportedCacheCoverage({ ...fixture, usage: { ...fixture.usage, cacheWrite: 10 } })).toMatchObject({
      rate: 0.75,
      readsComplete: true,
      partial: false
    })
  })
  it.each([
    { cacheReadReports: 1 },
    { inputReports: 1 },
    { observedRequests: 1 },
    { incompleteRequests: 1 },
    { performance: { upstreamRequests: 3 } }
  ])('does not infer a rate for missing/unfinished requests %#', (changes) => {
    expect(getReportedCacheCoverage({ ...fixture, ...changes } as OpenCodeTurnDiagnostics).rate).toBeUndefined()
  })
  it('distinguishes explicit cache zero from absence and prevents rates over 100%', () => {
    expect(getReportedCacheCoverage({ ...fixture, usage: { input: 200, cacheRead: 0 } }).rate).toBe(0)
    expect(getReportedCacheCoverage({ ...fixture, usage: { input: 100, cacheRead: 150 } })).toMatchObject({
      inconsistent: true,
      rate: undefined
    })
    expect(getReportedCacheCoverage({ ...fixture, usage: { input: 0, cacheRead: 0 } }).rate).toBeUndefined()
  })
})
