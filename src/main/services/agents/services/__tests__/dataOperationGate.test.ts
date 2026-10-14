import { describe, expect, it } from 'vitest'

import {
  acquireAssistantDataOperation,
  assertAssistantDataAvailable,
  ownsAssistantDataOperation
} from '../dataOperationGate'
import { acquireSessionActivity, hasAnySessionActivity } from '../sessionActivity'

describe('data-operation admission', () => {
  it('rejects both preparation and continuation before taking the data lock', () => {
    for (const kind of ['run', 'continuation'] as const) {
      const release = acquireSessionActivity('active', kind)
      try {
        expect(() => acquireAssistantDataOperation('restore', hasAnySessionActivity)).toThrow()
      } finally {
        release()
      }
      expect(() => assertAssistantDataAvailable()).not.toThrow()
    }
  })
  it('blocks new tasks and overlapping data operations until release', () => {
    const lock = acquireAssistantDataOperation('backup', hasAnySessionActivity, 5)
    try {
      expect(ownsAssistantDataOperation('backup', 5)).toBe(true)
      expect(ownsAssistantDataOperation('restore', 5)).toBe(false)
      expect(ownsAssistantDataOperation('backup', 6)).toBe(false)
      expect(() => acquireSessionActivity('new', 'run')).toThrow()
      expect(() => acquireAssistantDataOperation('reset', () => false)).toThrow()
    } finally {
      lock.release()
    }
    const next = acquireAssistantDataOperation('reset', () => false)
    lock.release()
    expect(() => assertAssistantDataAvailable()).toThrow()
    next.release()
    acquireSessionActivity('new', 'run')()
  })
})
