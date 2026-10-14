import type { AgentPersistedMessage } from '@types'
import { describe, expect, it } from 'vitest'

import { repairInterruptedHistory } from '../interruptedHistory'

const boot = Date.parse('2026-10-12T01:00:00Z')
const history = (status = 'processing', time = '2026-10-11T01:00:00Z') =>
  ({
    message: {
      id: 'reply',
      role: 'assistant',
      status,
      createdAt: time,
      blocks: ['text', 'tool', 'done'],
      providerMetadata: { opencode: { session_id: 'native-kept' } }
    },
    blocks: [
      { id: 'text', type: 'main_text', status: 'streaming', content: 'already saved text' },
      {
        id: 'tool',
        type: 'tool',
        status: 'processing',
        metadata: { rawMcpToolResponse: { status: 'invoking', response: 'partial output' } }
      },
      {
        id: 'done',
        type: 'tool',
        status: 'success',
        metadata: { rawMcpToolResponse: { status: 'done', response: 'saved-file.xlsx' } }
      }
    ]
  }) as unknown as AgentPersistedMessage

describe('restart display-state repair, not task replay', () => {
  it.each(['pending', 'processing', 'searching'])(
    'pauses previous-app %s content without deleting native memory or files',
    (status) => {
      const original = history(status)
      const repaired = repairInterruptedHistory(original, boot)
      expect(repaired.message).toMatchObject({
        status: 'paused',
        providerMetadata: { opencode: { session_id: 'native-kept' }, zenInterrupted: { automaticReplay: false } }
      })
      expect(repaired.blocks[0]).toMatchObject({ status: 'paused', content: 'already saved text' })
      expect(repaired.blocks[1].metadata?.rawMcpToolResponse).toMatchObject({
        status: 'cancelled',
        response: 'partial output'
      })
      expect(repaired.blocks[2]).toBe(original.blocks[2])
      expect(original.message.status).toBe(status)
      expect(repairInterruptedHistory(repaired, boot)).toBe(repaired)
    }
  )
  it.each(['success', 'error', 'paused'])('leaves terminal %s records alone', (status) => {
    const original = history(status)
    expect(repairInterruptedHistory(original, boot)).toBe(original)
  })
  it.each(['2026-10-12T01:00:00Z', '2026-10-12T02:00:00Z', 'invalid'])(
    'does not interfere with a current run or invent an invalid creation time (%s)',
    (time) => {
      const original = history('processing', time)
      expect(repairInterruptedHistory(original, boot)).toBe(original)
    }
  )
  it('never marks a user message interrupted', () => {
    const original = history()
    original.message.role = 'user'
    expect(repairInterruptedHistory(original, boot)).toBe(original)
  })
  it('uses app-run provenance rather than a changed wall clock when available', () => {
    const old = history('processing', '2099-01-01T00:00:00Z')
    expect(repairInterruptedHistory(old, boot, 'current-run').message.status).toBe('paused')
    const current = history('processing', '2000-01-01T00:00:00Z')
    current.message.providerMetadata = { zenAppRun: { id: 'current-run' } }
    expect(repairInterruptedHistory(current, boot, 'current-run')).toBe(current)
  })
})
