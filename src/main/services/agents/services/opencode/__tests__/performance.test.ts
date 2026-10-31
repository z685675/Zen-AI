import { describe, expect, it } from 'vitest'

import { OpenCodePerformance } from '../performance'

describe('new assistant passive performance evidence', () => {
  it('measures private context activity separately from first visible output', () => {
    let now = 0
    const timing = new OpenCodePerformance(() => now)
    now = 30_000
    timing.chunks([
      {
        type: 'raw',
        rawValue: {
          type: 'opencode_internal_progress',
          stage: 'compacting',
          kind: 'reasoning',
          characters: 12
        }
      }
    ])
    now = 200_000
    timing.chunks([
      {
        type: 'raw',
        rawValue: {
          type: 'opencode_internal_progress',
          stage: 'compacting',
          kind: 'text',
          characters: 18
        }
      }
    ])
    expect(timing.snapshot('failed')).toMatchObject({
      firstVisibleOutputMs: null,
      firstTextMs: null,
      contextProgress: { firstMs: 30_000, lastMs: 200_000, events: 2, characters: 30 }
    })
  })
  it('does not count quota admission failures or checks as upstream model time', () => {
    const timing = new OpenCodePerformance(() => 0)
    timing.transport('quota-check-started', { phase: 'quota-admission' })
    timing.transport('failed', { phase: 'quota-admission', durationMs: 10_018 })
    timing.transport('quota-check-complete', { phase: 'quota-admission', durationMs: 20 })
    expect(timing.snapshot('failed')).toMatchObject({ upstreamRequests: 0, upstreamRequestMs: 0 })
    timing.transport('request-started', {})
    timing.transport('body-complete', { durationMs: 50 })
    expect(timing.snapshot('completed')).toMatchObject({ upstreamRequests: 1, upstreamRequestMs: 50 })
  })
  it('distinguishes empty starts, visible tools and first actual text', () => {
    let now = 0
    const timing = new OpenCodePerformance(() => now)
    timing.changeStage('starting')
    now = 100
    timing.preparationMs = 100
    timing.changeStage('waiting_model')
    now = 200
    timing.chunks([{ type: 'text-start' }, { type: 'text-delta', text: '' }])
    now = 300
    timing.chunks([{ type: 'tool-call', toolCallId: 'one' }])
    timing.changeStage('busy')
    now = 500
    timing.chunks([{ type: 'tool-result', toolCallId: 'one' }])
    now = 600
    timing.chunks([{ type: 'text-delta', text: 'Answer' }])
    timing.transport('request-started', {})
    timing.transport('headers-received', { durationMs: 250 })
    timing.transport('body-complete', { durationMs: 400 })
    timing.retry()
    now = 900
    expect(timing.snapshot('completed')).toMatchObject({
      totalMs: 900,
      preparationMs: 100,
      firstVisibleOutputMs: 300,
      firstTextMs: 600,
      stageDurationsMs: { starting: 100, waiting_model: 200, busy: 600 },
      completedToolObservedMs: 200,
      toolCalls: 1,
      upstreamRequests: 1,
      upstreamHeaderWaitMs: 250,
      upstreamRequestMs: 400,
      retryEvents: 1
    })
  })
  it('keeps unobserved first text unknown and incomplete tools separate', () => {
    let now = 10
    const timing = new OpenCodePerformance(() => now)
    timing.chunks([{ type: 'tool-call', toolCallId: 'one' }])
    now = 110
    expect(timing.snapshot('cancelled')).toMatchObject({
      outcome: 'cancelled',
      firstTextMs: null,
      completedToolObservedMs: 0,
      unfinishedTools: 1
    })
  })
})
