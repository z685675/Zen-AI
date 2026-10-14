import { describe, expect, it } from 'vitest'

import { OPENCODE_SYSTEM_INSTRUCTIONS } from '../instructions'

describe('new assistant task contract', () => {
  it('keeps a finite stable contract instead of copying the legacy orchestration prompt', () => {
    expect(OPENCODE_SYSTEM_INSTRUCTIONS.length).toBeLessThan(6_000)
    expect(OPENCODE_SYSTEM_INSTRUCTIONS).not.toMatch(/\b(?:Exa|checkpoint|heartbeat|codex|claude-code|soul_enabled)\b/i)
  })
  it('does not make greetings run tools, skill discovery or environment checks', () => {
    expect(OPENCODE_SYSTEM_INSTRUCTIONS).toContain('Answer greetings and simple questions directly, without tools')
    expect(OPENCODE_SYSTEM_INSTRUCTIONS).toContain('skill discovery or environment checks')
  })
  it('requires real deliverables and explains the limits of validation', () => {
    expect(OPENCODE_SYSTEM_INSTRUCTIONS).toContain('actually do that work')
    expect(OPENCODE_SYSTEM_INSTRUCTIONS).toContain('A tool error or incomplete check is not success')
    expect(OPENCODE_SYSTEM_INSTRUCTIONS).toContain('existence-only is not content validation')
    expect(OPENCODE_SYSTEM_INSTRUCTIONS).toContain('do not register its unchanged output again')
  })
  it('covers inventory, provenance, batching and partial attachment evidence', () => {
    for (const rule of [
      'saved-path and failed-attachment lists',
      'sheet, page or section provenance',
      'manageable batches',
      'not all files at once or again every turn',
      'OCR fallback is partial evidence',
      'Never silently omit an attachment',
      'do not fabricate a complete result'
    ]) {
      expect(OPENCODE_SYSTEM_INSTRUCTIONS).toContain(rule)
    }
  })
  it('keeps safe recovery, actual sources and existing authorization boundaries', () => {
    expect(OPENCODE_SYSTEM_INSTRUCTIONS).toContain('never replay completed writes')
    expect(OPENCODE_SYSTEM_INSTRUCTIONS).toContain('Cite real source pages')
    expect(OPENCODE_SYSTEM_INSTRUCTIONS).toContain('already explicitly authorized')
    expect(OPENCODE_SYSTEM_INSTRUCTIONS).toContain('Scheduling/IM capabilities are not connected')
    expect(OPENCODE_SYSTEM_INSTRUCTIONS).toContain('Native memory is this conversation only')
  })
})
