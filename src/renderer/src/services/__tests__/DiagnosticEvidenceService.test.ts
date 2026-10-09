import { describe, expect, it } from 'vitest'

import { beginDiagnostic, getDiagnosticEvidence, recordDiagnostic } from '../DiagnosticEvidenceService'

describe('per-send diagnostic isolation', () => {
  it('uses a fresh operation on regeneration and ignores events from the old generation', () => {
    const first = beginDiagnostic('same-message', { source: 'chat' })
    recordDiagnostic(first, 'transport', 'request-started')
    const second = beginDiagnostic('same-message', { source: 'chat' })
    expect(first).not.toBe(second)
    recordDiagnostic(first, 'transport', 'failed', { error: 'late old failure' })
    recordDiagnostic(second, 'transport', 'headers-received')
    expect(getDiagnosticEvidence('same-message')?.events.map((event) => event.event)).toEqual(['headers-received'])
  })
  it('does not allow diagnostic storage failures to break sending', () => {
    const original = window.keyv
    Object.assign(window, {
      keyv: {
        get: () => {
          throw new Error('storage unavailable')
        },
        set: () => {
          throw new Error('storage unavailable')
        }
      }
    })
    try {
      expect(() => beginDiagnostic('storage-failure', {})).not.toThrow()
      expect(() => recordDiagnostic('storage-failure', 'response', 'first-content')).not.toThrow()
    } finally {
      Object.assign(window, { keyv: original })
    }
  })
})
