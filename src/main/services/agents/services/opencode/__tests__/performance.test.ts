import { describe, expect, it } from 'vitest'

import { OpenCodePerformance } from '../performance'

describe('new assistant passive performance evidence', () => {
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
