import { describe, expect, it } from 'vitest'

import type { DiagnosticEvent } from '../diagnostics'
import { buildTurnPerformance } from '../turnPerformance'
import { LIVE_RENDER_MEASUREMENT } from '../turnRenderTiming'

const at = (ms: number) => new Date(Date.UTC(2026, 9, 24) + ms).toISOString()
const event = (ms: number, stage: DiagnosticEvent['stage'], name: string, details = {}): DiagnosticEvent => ({
  at: at(ms),
  stage,
  event: name,
  details
})

describe('turn performance evidence', () => {
  it('separates headers, first bytes, reasoning and answer text and does not add parallel spans', () => {
    const report = buildTurnPerformance({
      startedAt: at(0),
      finishedAt: at(9000),
      outcome: 'completed',
      events: [
        event(0, 'preparation', 'started'),
        event(500, 'preparation', 'messages-ready'),
        event(500, 'transport', 'request-started', { traceId: 'r' }),
        event(1500, 'transport', 'headers-received', { traceId: 'r', requestId: 'api-1' }),
        event(2000, 'transport', 'first-bytes', { traceId: 'r' }),
        event(2500, 'response', 'first-content'),
        event(3000, 'tool', 'tool-call', { toolCallId: 't1', toolName: 'read' }),
        event(3500, 'tool', 'tool-call', { toolCallId: 't2', toolName: 'read' }),
        event(6000, 'tool', 'tool-result', { toolCallId: 't2' }),
        event(6500, 'tool', 'tool-result', { toolCallId: 't1' }),
        event(7000, 'response', 'first-text'),
        event(8500, 'transport', 'body-complete', { traceId: 'r' }),
        event(9200, 'ui', 'render-committed', {
          measurement: LIVE_RENDER_MEASUREMENT,
          observedActiveAt: at(1000),
          responseFinishedAt: at(9000)
        })
      ]
    })
    expect(report).toMatchObject({
      totalMs: 9000,
      firstBytesMs: 2000,
      firstContentMs: 2500,
      firstTextMs: 7000,
      observedRequests: 1,
      toolCalls: 2,
      renderCommitDelayMs: 200,
      coverage: { durationsAreAdditive: false, activeWorkMs: null }
    })
    expect(report.intervals.find((span) => span.kind === 'request')).toMatchObject({
      durationMs: 8000,
      headersMs: 1000,
      firstBytesMs: 1500,
      requestId: 'api-1'
    })
  })
  it('does not treat a legacy mount recorded 174.85 seconds later as UI latency', () => {
    const lateMount = event(184848, 'ui', 'render-committed', { status: 'success' })
    const report = buildTurnPerformance({
      startedAt: at(0),
      finishedAt: at(10000),
      events: [event(10121, 'ui', 'state-applied'), lateMount]
    })
    expect(report.totalMs).toBe(10000)
    expect(report.uiStateAppliedAt).toBe(at(10121))
    expect(report.renderCommittedAt).toBeNull()
    expect(report.renderCommitDelayMs).toBeNull()
    expect(report.coverage.missing).toContain('live-ui-commit-not-observed')
  })
  it('keeps the first verified commit and ignores later or different-turn observations', () => {
    const details = {
      measurement: LIVE_RENDER_MEASUREMENT,
      observedActiveAt: at(1000),
      responseFinishedAt: at(10000)
    }
    const report = buildTurnPerformance({
      startedAt: at(0),
      finishedAt: at(10000),
      events: [
        event(184848, 'ui', 'render-committed', details),
        event(10010, 'ui', 'render-committed', { ...details, responseFinishedAt: at(5000) }),
        event(10200, 'ui', 'render-committed', details)
      ]
    })
    expect(report.renderCommitDelayMs).toBe(200)
    expect(report.renderCommittedAt).toBe(at(10200))
    expect(report.coverage.missing).not.toContain('live-ui-commit-not-observed')
  })
  it('rejects incomplete, restored-after-completion and invalid-clock render evidence', () => {
    for (const details of [
      { observedActiveAt: at(1000), responseFinishedAt: at(10000) },
      { measurement: LIVE_RENDER_MEASUREMENT, observedActiveAt: at(11000), responseFinishedAt: at(10000) },
      { measurement: LIVE_RENDER_MEASUREMENT, observedActiveAt: 'invalid', responseFinishedAt: at(10000) },
      { measurement: LIVE_RENDER_MEASUREMENT, observedActiveAt: at(1000), responseFinishedAt: 'invalid' }
    ]) {
      expect(
        buildTurnPerformance({
          startedAt: at(0),
          finishedAt: at(10000),
          events: [event(12000, 'ui', 'render-committed', details)]
        }).renderCommitDelayMs
      ).toBeNull()
    }
  })
  it('retains a genuinely slow observed live commit without applying an arbitrary time cap', () => {
    const report = buildTurnPerformance({
      startedAt: at(0),
      finishedAt: at(10000),
      events: [
        event(184848, 'ui', 'render-committed', {
          measurement: LIVE_RENDER_MEASUREMENT,
          observedActiveAt: at(1000),
          responseFinishedAt: at(10000)
        })
      ]
    })
    expect(report.renderCommitDelayMs).toBe(174848)
  })
  it('keeps concurrent native requests separate even when response headers have no trace ID', () => {
    const report = buildTurnPerformance({
      events: [
        event(0, 'transport', 'request-started', { transportRequestId: 'a' }),
        event(100, 'transport', 'request-started', { transportRequestId: 'b' }),
        event(200, 'transport', 'headers-received', { transportRequestId: 'b', requestId: 'b-api' }),
        event(400, 'transport', 'body-complete', { transportRequestId: 'a' }),
        event(600, 'transport', 'body-complete', { transportRequestId: 'b' })
      ]
    })
    expect(report.observedRequests).toBe(2)
    expect(report.intervals.map((span) => span.durationMs)).toEqual([400, 500])
    expect(report.intervals[1].requestId).toBe('b-api')
  })
  it('keeps in-progress and expired evidence unknown instead of creating zero durations or a failure', () => {
    const report = buildTurnPerformance({
      outcome: 'processing',
      droppedEvents: 20,
      events: [
        event(0, 'transport', 'request-started', { traceId: 'r' }),
        event(100, 'tool', 'tool-result', { toolCallId: 'missing-start' })
      ]
    })
    expect(report).toMatchObject({ outcome: 'processing', totalMs: null, firstTextMs: null, droppedEvents: 20 })
    expect(report.intervals[0].durationMs).toBeNull()
    expect(report.coverage.missing).toContain('bounded-events-truncated')
    expect(buildTurnPerformance({ events: [] }).outcome).toBe('unrecorded')
  })
  it('does not match an unknown attempt to a different active request and counts reused trace IDs', () => {
    const report = buildTurnPerformance({
      events: [
        event(0, 'transport', 'request-started', { traceId: 'reused' }),
        event(100, 'transport', 'body-complete', { traceId: 'missing-start' }),
        event(200, 'transport', 'body-complete', { traceId: 'reused' }),
        event(300, 'transport', 'request-started', { traceId: 'reused' }),
        event(500, 'transport', 'headers-received', { traceId: 'reused', status: 503 })
      ]
    })
    expect(report.observedRequests).toBe(2)
    expect(report.intervals.map((span) => span.durationMs)).toEqual([200, null])
    expect(report.intervals[1].httpStatus).toBe(503)
    expect(report.intervals[1].headersMs).toBe(200)
  })
  it('includes time reading an HTTP error body instead of ending its request span at headers', () => {
    const report = buildTurnPerformance({
      events: [
        event(0, 'transport', 'request-started', { transportRequestId: 'error-body' }),
        event(100, 'transport', 'headers-received', { transportRequestId: 'error-body', status: 503 }),
        event(900, 'transport', 'failed', { transportRequestId: 'error-body' })
      ]
    })
    expect(report.intervals[0]).toMatchObject({ httpStatus: 503, headersMs: 100, durationMs: 900, outcome: 'failed' })
  })
  it('orders valid timestamps by instant rather than by their timezone notation', () => {
    const report = buildTurnPerformance({
      events: [
        { at: '2026-10-24T08:00:00+08:00', stage: 'transport', event: 'request-started', details: { traceId: 'r' } },
        event(100, 'transport', 'body-complete', { traceId: 'r' })
      ]
    })
    expect(report.intervals[0].durationMs).toBe(100)
  })
  it('identifies permission/browser waits without treating their tool overlaps as separate active work', () => {
    const report = buildTurnPerformance({
      events: [
        event(0, 'runtime', 'task-stage', { stage: 'waiting_permission' }),
        event(100, 'tool', 'tool-call', { toolCallId: 'login', toolName: 'browser_wait_for_user' }),
        event(3000, 'runtime', 'task-stage', { stage: 'busy' }),
        event(3100, 'tool', 'tool-result', { toolCallId: 'login' }),
        event(3500, 'runtime', 'complete')
      ]
    })
    expect(report.userWaitIntervals.map((span) => span.durationMs)).toEqual([3000, 3000])
    expect(report.coverage.activeWorkMs).toBeNull()
  })
  it('ignores invalid and negative clock differences and deduplicates repeated tool starts', () => {
    const report = buildTurnPerformance({
      startedAt: at(9000),
      finishedAt: at(0),
      events: [
        { at: 'invalid', stage: 'response', event: 'first-text' },
        event(100, 'tool', 'tool-call', { toolCallId: 't' }),
        event(200, 'tool', 'tool-call', { toolCallId: 't' }),
        event(400, 'tool', 'tool-result', { toolCallId: 't' })
      ]
    })
    expect(report.totalMs).toBeNull()
    expect(report.toolCalls).toBe(1)
    expect(report.intervals[0].durationMs).toBe(300)
  })
})
