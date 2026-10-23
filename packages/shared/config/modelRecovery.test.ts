import { describe, expect, it } from 'vitest'

import { isTextFallbackIdentifier, selectRecoverableModel } from './modelRecovery'

describe('model intent and automatic cost-priority recovery', () => {
  it('falls through only configured candidates, preserves A and returns after stability', () => {
    const failed = selectRecoverableModel({ current: 'A', available: ['C'], fallbacks: ['B', 'C', 'C'], now: 1 })
    expect(failed.selected).toBe('C')
    expect(failed.intent?.preferred).toBe('A')
    const restored = selectRecoverableModel({
      current: 'C',
      available: ['A', 'C'],
      fallbacks: ['B', 'C'],
      intent: failed.intent,
      now: 10
    })
    expect(restored.selected).toBe('C')
    expect(
      selectRecoverableModel({
        current: 'C',
        available: ['A', 'C'],
        fallbacks: [],
        intent: restored.intent,
        now: 300_010
      }).selected
    ).toBe('A')
  })
  it('restarts at A when B fails instead of blindly continuing to C', () => {
    expect(
      selectRecoverableModel({
        current: 'B',
        available: ['A', 'C'],
        fallbacks: ['B', 'C'],
        intent: { preferred: 'A', actual: 'B', unavailableAt: 1 },
        now: 5
      }).selected
    ).toBe('A')
  })
  it('never picks an unconfigured model and recovers from an empty selection', () => {
    const failed = selectRecoverableModel({ current: 'A', available: ['expensive'], fallbacks: ['B'], now: 1 })
    expect(failed.selected).toBeNull()
    expect(
      selectRecoverableModel({ current: null, available: ['A'], fallbacks: [], intent: failed.intent, now: 2 }).selected
    ).toBe('A')
  })
  it('respects a manual C choice, including explicitly choosing the same temporary B', () => {
    const intent = { preferred: 'A', actual: 'B', unavailableAt: 1 }
    expect(
      selectRecoverableModel({ current: 'C', available: ['A', 'C'], fallbacks: [], intent, now: 5 }).intent?.preferred
    ).toBe('C')
    expect(
      selectRecoverableModel({ current: 'B', available: ['A', 'B'], fallbacks: [], intent, manual: true, now: 5 })
        .intent?.preferred
    ).toBe('B')
  })
  it('backs off repeatedly flapping primary recovery', () => {
    const result = selectRecoverableModel({
      current: 'B',
      available: ['B'],
      fallbacks: ['B'],
      intent: { preferred: 'A', actual: 'B', unavailableAt: 1, recoveredAt: 5 },
      now: 10
    })
    expect(result.intent?.recoveryDelayMs).toBe(600_000)
    expect(result.intent?.recoveredAt).toBeUndefined()
  })
  it('waits a full five minutes even for an old persisted shorter recovery delay', () => {
    const input = {
      current: 'B',
      available: ['A', 'B'],
      fallbacks: ['B'],
      intent: { preferred: 'A', actual: 'B', unavailableAt: 1, recoveredAt: 10, recoveryDelayMs: 120_000 },
      now: 300_009
    }
    expect(selectRecoverableModel(input).selected).toBe('B')
    expect(selectRecoverableModel({ ...input, now: 300_010 }).selected).toBe('A')
  })
  it('restarts the stability clock on failure and caps repeated flapping at fifteen minutes', () => {
    const failed = selectRecoverableModel({
      current: 'B',
      available: ['B'],
      fallbacks: ['B'],
      intent: { preferred: 'A', actual: 'B', unavailableAt: 1, recoveredAt: 10, recoveryDelayMs: 600_000 },
      now: 299_999
    })
    expect(failed.intent?.recoveryDelayMs).toBe(900_000)
    const restored = selectRecoverableModel({
      current: 'B',
      available: ['A', 'B'],
      fallbacks: ['B'],
      intent: failed.intent,
      now: 400_000
    })
    expect(restored.intent?.recoveredAt).toBe(400_000)
    expect(
      selectRecoverableModel({
        current: 'B',
        available: ['A', 'B'],
        fallbacks: ['B'],
        intent: restored.intent,
        now: 1_299_999
      }).selected
    ).toBe('B')
  })
  it('keeps explicit D intent, not the panel default A', () => {
    const result = selectRecoverableModel({ current: 'D', preferred: 'A', available: ['B'], fallbacks: ['B'], now: 1 })
    expect(result.intent?.preferred).toBe('D')
  })
  it('excludes non-text purposes without a new capability-maintenance panel', () => {
    for (const id of [
      'gpt-image2',
      'gemini-3-pro-image-preview',
      'flux-2',
      'text-embedding-3-large',
      'whisper-1',
      'sora-2'
    ])
      expect(isTextFallbackIdentifier(id)).toBe(false)
    expect(isTextFallbackIdentifier('gpt-6.1-sol')).toBe(true)
  })
})
