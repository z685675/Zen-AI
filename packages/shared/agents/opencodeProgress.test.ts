import { describe, expect, it } from 'vitest'

import { isOpenCodeInternalProgress } from './opencodeProgress'

describe('native internal progress admission', () => {
  it('accepts growing content or a completed boundary, never heartbeats or malformed counters', () => {
    const progress = { type: 'opencode_internal_progress', stage: 'compacting', kind: 'text', characters: 1 }
    expect(isOpenCodeInternalProgress(progress)).toBe(true)
    expect(isOpenCodeInternalProgress({ ...progress, kind: 'completed', characters: 0 })).toBe(true)
    for (const invalid of [
      null,
      {},
      { ...progress, type: 'opencode_status' },
      { ...progress, stage: 'busy' },
      { ...progress, characters: 0 },
      { ...progress, characters: -1 },
      { ...progress, characters: NaN },
      { ...progress, characters: 1.5 },
      { ...progress, kind: 'completed', characters: 1 }
    ]) {
      expect(isOpenCodeInternalProgress(invalid)).toBe(false)
    }
  })
})
