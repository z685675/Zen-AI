import { describe, expect, it } from 'vitest'

import { type OpenCodeTurnDiagnostics, readOpenCodeTurnDiagnostics } from './opencodeDiagnostics'

const fixture: OpenCodeTurnDiagnostics = {
  version: 1,
  providerId: 'local',
  modelId: 'test',
  usage: { input: 100, output: 5, cacheRead: 0 },
  observedRequests: 1,
  reportedRequests: 1,
  inputReports: 1,
  outputReports: 1,
  cacheReadReports: 1,
  cacheWriteReports: 0,
  incompleteRequests: 0,
  performance: {
    outcome: 'completed',
    totalMs: 10,
    preparationMs: null,
    upstreamRequests: 1,
    upstreamHeaderWaitMs: 1,
    upstreamRequestMs: 5,
    retryEvents: 0,
    toolCalls: 0,
    completedToolObservedMs: 0,
    unfinishedTools: 0
  }
}
describe('stored usage observation validation', () => {
  it('retains numeric context progress without persisting private summary content', () => {
    const contextProgress = { firstMs: 100, lastMs: 200, events: 2, characters: 30 }
    const result = readOpenCodeTurnDiagnostics({
      ...fixture,
      performance: {
        ...fixture.performance,
        contextProgress: { ...contextProgress, text: 'PRIVATE_SUMMARY' }
      }
    })
    expect(result?.performance.contextProgress).toEqual(contextProgress)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SUMMARY')
    expect(
      readOpenCodeTurnDiagnostics({
        ...fixture,
        performance: {
          ...fixture.performance,
          contextProgress: { ...contextProgress, lastMs: -1 }
        }
      })
    ).toBeUndefined()
  })
  it('strips unrecognized content and credentials before persistence', () => {
    expect(
      readOpenCodeTurnDiagnostics({
        ...fixture,
        apiKey: 'sk-private',
        response: 'private content',
        usage: { ...fixture.usage, raw: 'private usage' },
        performance: { ...fixture.performance, content: 'private stream' }
      })
    ).toEqual(fixture)
  })
  it('accepts explicit zeros and optional absent token fields', () => {
    expect(readOpenCodeTurnDiagnostics(fixture)).toEqual(fixture)
    expect(readOpenCodeTurnDiagnostics({ ...fixture, usage: {} })).toBeDefined()
  })
  it.each([
    null,
    1,
    {},
    { ...fixture, version: 2 },
    { ...fixture, usage: { input: -1 } },
    { ...fixture, cacheReadReports: 2 },
    { ...fixture, performance: { ...fixture.performance, totalMs: NaN } },
    { ...fixture, usage: { output: '5' } }
  ])('rejects corrupt or unsupported metadata %#', (value) => {
    expect(readOpenCodeTurnDiagnostics(value)).toBeUndefined()
  })
})
