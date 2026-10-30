import { describe, expect, it } from 'vitest'

import { buildServerPerformance, serverAttemptTiming, serverPhases } from '../serverTiming'
import { buildTurnPerformance } from '../turnPerformance'

const start = '2026-10-27T06:00:00.000Z'
const end = '2026-10-27T06:00:24.000Z'
const entry = {
  requestId: 'request-1',
  startedAt: start,
  finishedAt: end,
  outcome: 'succeeded',
  phases: { body_ready: 0, routing_ready: 800, tokens_ready: 1900, admission_ready: 2000 },
  attempts: [
    {
      index: 1,
      channelId: 57,
      startedAt: '2026-10-27T06:00:02.000Z',
      durationMs: 22000,
      outcome: 'succeeded',
      timing: {
        startedAt: '2026-10-27T06:00:02.000Z',
        milestones: { first_event: 16000, first_content: 21000, first_text: 21000, first_forward: 21020 },
        http: [
          {
            started_at: '2026-10-27T06:00:02.010Z',
            attempt_offset_ms: 10,
            connection_ready_ms: 50,
            request_sent_ms: 80,
            first_byte_ms: 15990,
            wait_after_send_ms: 15910,
            body_complete: true,
            connection_reused: true,
            response_bytes: 3000,
            total_ms: 21990
          }
        ]
      }
    }
  ]
}

describe('correlated server timing', () => {
  it('compares elapsed durations without mixing client and server wall clocks', () => {
    const result = buildServerPerformance([entry], [{ requestId: 'request-1', durationMs: 28000 }])[0]
    expect(result).toMatchObject({ totalMs: 24000, outsideGatewayMs: 4000, phases: { body_ready: 0 } })
    expect(result.attempts[0]).toMatchObject({
      gatewayBeforeAttemptMs: 2000,
      firstContentAfterEventMs: 5000,
      firstForwardAfterContentMs: 20
    })
    expect(result.attempts[0].timing?.http[0].wait_after_send_ms).toBe(15910)
    expect(result.attempts[0].timing?.http[0].dns_ms).toBeUndefined()
    expect(
      buildServerPerformance([entry], [{ requestId: 'different-request', durationMs: 28000 }])[0].outsideGatewayMs
    ).toBeNull()
    expect(
      buildServerPerformance([entry], [{ requestId: 'request-1', durationMs: 23000 }])[0].outsideGatewayMs
    ).toBeNull()
  })

  it('keeps retries and multiple requests separate and preserves zero and missing values', () => {
    const pending = { index: 2, startedAt: end, durationMs: 0, outcome: 'pending' }
    const result = buildServerPerformance(
      [
        { ...entry, attempts: [...entry.attempts, pending], droppedAttempts: 2 },
        { requestId: 'old-request', startedAt: start, finishedAt: end, attempts: [{ durationMs: 24000 }] }
      ],
      []
    )
    expect(result).toHaveLength(2)
    expect(result[0].attempts[1]).toMatchObject({ durationMs: null, timing: null })
    expect(result[0].missing).toContain('bounded-channel-attempts-truncated')
    expect(result[1].attempts[0].missing).toContain('server-attempt-timing-not-recorded')
    expect(result[1].phases).toEqual({})
  })

  it('does not label metadata forwarded before content as a negative buffering delay', () => {
    const early = {
      ...entry.attempts[0],
      timing: { ...entry.attempts[0].timing, milestones: { first_event: 10, first_content: 21000, first_forward: 20 } }
    }
    expect(
      buildServerPerformance([{ ...entry, attempts: [early] }], [])[0].attempts[0].firstForwardAfterContentMs
    ).toBeNull()
  })

  it('only retains bounded known numeric and boolean metrics, never content strings', () => {
    expect(serverPhases({ body_ready: 0, tokens_ready: 'PRIVATE', unknown: 100, routing_ready: -1 })).toEqual({
      body_ready: 0
    })
    const timing = serverAttemptTiming({
      startedAt: start,
      milestones: { first_event: 0, first_text: Infinity, first_content: 'PRIVATE', prompt: 'PRIVATE' },
      http: Array.from({ length: 20 }, () => ({
        started_at: start,
        request_sent_ms: 10,
        dns_ms: 'PRIVATE',
        body_complete: true,
        authorization: 'PRIVATE',
        prompt: 'PRIVATE',
        connection_reused: 'PRIVATE'
      }))
    })
    expect(timing?.http).toHaveLength(8)
    expect(timing?.milestones).toEqual({ first_event: 0 })
    expect(JSON.stringify(timing)).not.toContain('PRIVATE')
    expect(serverAttemptTiming(undefined)).toBeUndefined()
    expect(
      serverAttemptTiming({
        startedAt: start,
        http: [{ upstream_request_id: 'upstream-id' }, { upstream_request_id: 'Bearer PRIVATE' }]
      })?.http
    ).toEqual([{ upstream_request_id: 'upstream-id' }, {}])
  })

  it('reports uncorrelated client requests and carries server details into performance JSON', () => {
    const result = buildTurnPerformance({
      startedAt: start,
      finishedAt: end,
      events: [
        { at: start, stage: 'transport', event: 'request-started', details: { traceId: 'client-1' } },
        {
          at: end,
          stage: 'transport',
          event: 'headers-received',
          details: { traceId: 'client-1', requestId: 'request-1' }
        },
        { at: end, stage: 'transport', event: 'body-complete', details: { traceId: 'client-1' } }
      ],
      backendEvidence: [entry]
    })
    expect(result.serverRequests[0].requestId).toBe('request-1')
    expect(result.coverage.missing).not.toContain('some-client-requests-lack-server-evidence')
    expect(buildTurnPerformance({ events: [], backendEvidence: [] }).serverRequests).toEqual([])
  })
})
