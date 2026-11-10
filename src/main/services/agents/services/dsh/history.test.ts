import type { AgentPersistedMessage } from '@types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../dshPreview/runtime', () => ({ readDshSessionHistory: vi.fn(), replaceDshSessionHistory: vi.fn() }))
import { readDshSessionHistory, replaceDshSessionHistory } from '../../../dshPreview/runtime'
import { acquireSessionActivity } from '../sessionActivity'
import { editDshNativeHistory, planDshHistory } from './history'

const events = [
  { type: 'turn/start', seq: 0, data: {} },
  { type: 'user/message', seq: 1, data: { id: 'native-1' } },
  { type: 'assistant/message', seq: 2, data: {} },
  { type: 'turn/end', seq: 3, data: {} },
  { type: 'turn/start', seq: 4, data: {} },
  { type: 'user/message', seq: 5, data: { id: 'native-2' } },
  { type: 'assistant/message', seq: 6, data: {} },
  { type: 'turn/end', seq: 7, data: {} }
]
const display = (['u1', 'a1', 'u2', 'a2'] as const).map((id, index) => ({
  message: {
    id,
    role: id[0] === 'u' ? 'user' : 'assistant',
    askId: id[0] === 'a' ? `u${id[1]}` : undefined,
    providerMetadata: { dsh: { user_message_id: `native-${index < 2 ? 1 : 2}` } }
  },
  blocks: []
})) as unknown as AgentPersistedMessage[]

describe('DSH native history prefixes', () => {
  it('retry keeps only earlier closed turns and the original user input to resend', () => {
    const result = planDshHistory(events, display, 'a2', 'retry')
    expect(result.events).toEqual(events.slice(0, 4))
    expect(result.items.map((item) => item.message.id)).toEqual(['u1', 'a1', 'u2'])
  })
  it('delete truncates the whole selected turn and later turns in both stores', () => {
    const result = planDshHistory(events, display, 'a1', 'delete')
    expect(result.events).toEqual([])
    expect(result.items).toEqual([])
  })
  it('fork copies a closed prefix without retaining later display messages', () => {
    const result = planDshHistory(events, display, 'a1', 'fork')
    expect(result.events).toEqual(events.slice(0, 4))
    expect(result.items.map((item) => item.message.id)).toEqual(['u1', 'a1'])
    expect(display[0].message.agentSessionId).toBeUndefined()
  })
  it('refuses unmatched native identities and unfinished turns without guessing', () => {
    expect(() =>
      planDshHistory(
        events.filter((event) => event.seq !== 1),
        display,
        'a1',
        'delete'
      )
    ).toThrow('do not match')
    expect(() => planDshHistory(events.slice(0, -1), display, 'a2', 'fork')).toThrow('still open')
  })

  it('restores the native history after a database failure and releases the operation lease', async () => {
    vi.mocked(readDshSessionHistory).mockResolvedValue({ sessionId: 'old', events })
    vi.mocked(replaceDshSessionHistory).mockResolvedValue({ sessionId: 'new', events: events.slice(0, 4) })
    const commit = vi.fn().mockRejectedValue(new Error('database failed'))
    await expect(
      editDshNativeHistory({ id: 'history-rollback' } as any, display, 'a2', 'retry', commit)
    ).rejects.toThrow('database failed')
    expect(vi.mocked(replaceDshSessionHistory).mock.calls.at(-1)).toEqual(['history-rollback', events])
    const release = acquireSessionActivity('history-rollback', 'run')
    release()
  })

  it('refuses to change an actively running native session', async () => {
    const release = acquireSessionActivity('history-busy', 'run')
    try {
      await expect(
        editDshNativeHistory({ id: 'history-busy' } as any, display, 'a1', 'delete', vi.fn())
      ).rejects.toThrow('Stop the active task')
    } finally {
      release()
    }
  })
})
