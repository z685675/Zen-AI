import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { diagnosticHistorySnapshot } from '../diagnosticHistorySnapshot'

const originalElectron = window.electron
afterEach(() => {
  Object.assign(window, { electron: originalElectron })
  vi.useRealTimers()
})
const selected = {
  id: 'selected',
  topicId: 'agent-session:s',
  role: 'assistant',
  status: 'success',
  blocks: ['missing', 'pending'],
  providerMetadata: { zenDiagnostic: { operationId: 'run' } }
} as Message

describe('selected turn diagnostic block recovery', () => {
  it('recovers missing and terminal tool results without exporting other turns or assuming all tools succeeded', async () => {
    const blocks = [
      { id: 'missing', messageId: 'selected', type: 'tool', status: 'pending' },
      { id: 'pending', messageId: 'selected', type: 'tool', status: 'success', metadata: { result: 'delivered' } },
      {
        id: 'private-other-turn',
        messageId: 'other',
        type: 'main_text',
        status: 'success',
        content: 'other private answer'
      }
    ] as MessageBlock[]
    const invoke = vi.fn(async () => [{ message: selected, blocks }])
    Object.assign(window, { electron: { ipcRenderer: { invoke } } })
    const result = await diagnosticHistorySnapshot(selected, {
      pending: { ...blocks[1], status: 'pending' } as MessageBlock
    })
    expect(result.status).toBe('collected-selected-turn')
    expect(result.operationId).toBe('run')
    expect(Object.keys(result.entities)).toEqual(['pending', 'missing'])
    expect(result.entities.missing?.status).toBe('pending')
    expect(result.entities.pending?.status).toBe('success')
  })

  it('does not mix a previous attempt into a retried turn or refresh an active snapshot', async () => {
    const invoke = vi.fn(async () => [
      { message: { ...selected, providerMetadata: { zenDiagnostic: { operationId: 'old-run' } } }, blocks: [] }
    ])
    Object.assign(window, { electron: { ipcRenderer: { invoke } } })
    expect((await diagnosticHistorySnapshot(selected, {})).status).toBe('different-operation')
    expect((await diagnosticHistorySnapshot({ ...selected, status: 'processing' } as Message, {})).status).toBe(
      'not-applicable'
    )
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('bounds collection time without replaying any model or tool request', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn(() => new Promise(() => {}))
    Object.assign(window, { electron: { ipcRenderer: { invoke } } })
    const collecting = diagnosticHistorySnapshot(selected, {})
    await vi.advanceTimersByTimeAsync(3000)
    expect((await collecting).status).toBe('unavailable-or-timed-out')
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('does not hydrate a legacy snapshot from a later retry when operation IDs were not recorded', async () => {
    const older = { ...selected, providerMetadata: undefined, updatedAt: '2026-11-03T12:00:00Z' }
    const invoke = vi.fn(async () => [{ message: { ...older, updatedAt: '2026-11-03T13:00:00Z' }, blocks: [] }])
    Object.assign(window, { electron: { ipcRenderer: { invoke } } })
    expect((await diagnosticHistorySnapshot(older, {})).status).toBe('different-snapshot')
  })
})
