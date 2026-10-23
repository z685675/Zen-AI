import { describe, expect, it, vi } from 'vitest'

import { type CompactionEntry, discardEmptyNativeCompaction } from '../compactionGuard'

const entries = (text = ''): CompactionEntry[] => [
  {
    info: { id: 'original', role: 'user' },
    parts: [{ id: 'request', type: 'text', text: 'Important original history' }]
  },
  {
    info: { id: 'marker', role: 'user' },
    parts: [
      { id: 'compaction', type: 'compaction' },
      { id: 'other', type: 'text', text: 'Do not delete' }
    ]
  },
  {
    info: { id: 'summary', role: 'assistant', summary: true, parentID: 'marker', finish: 'stop' },
    parts: [{ id: 'text', type: 'text', text }]
  }
]

describe('native empty-summary admission guard', () => {
  it('still repairs an empty accepted boundary when a later summary failed', async () => {
    const client = { request: vi.fn() }
    const history = entries()
    history.push({
      info: { id: 'failed-later', role: 'assistant', summary: true, finish: 'error', error: { name: 'APIError' } },
      parts: []
    })
    expect(await discardEmptyNativeCompaction(client, 'session', history, new AbortController().signal)).toBe(true)
    expect(client.request.mock.calls[0][0]).toBe('/session/session/message/summary')
  })
  it('discards only an empty summary and its marker, never original history or sibling parts', async () => {
    const client = { request: vi.fn() }
    expect(
      await discardEmptyNativeCompaction(client, 'session', entries('  '), new AbortController().signal, true)
    ).toBe(true)
    expect(client.request.mock.calls.map(([route, method]) => [route, method])).toEqual([
      ['/session/session/abort', 'POST'],
      ['/session/session/message/summary', 'DELETE'],
      ['/session/session/message/marker/part/compaction', 'DELETE']
    ])
  })
  it('does not resubmit, summarize, abort or change an ordinary/failed/in-flight/nonempty checkpoint', async () => {
    for (const fixture of [
      entries('valid summary'),
      [],
      entries().slice(0, 2),
      entries().map((entry) => ({ ...entry, info: { ...entry.info, finish: undefined } })),
      entries().map((entry) => ({ ...entry, info: { ...entry.info, error: { name: 'APIError' } } }))
    ]) {
      const client = { request: vi.fn() }
      expect(await discardEmptyNativeCompaction(client, 'session', fixture, new AbortController().signal)).toBe(false)
      expect(client.request).not.toHaveBeenCalled()
    }
  })
  it('repairs an existing empty checkpoint before a new submission without aborting an idle task', async () => {
    const client = { request: vi.fn() }
    await discardEmptyNativeCompaction(client, 'session', entries(), new AbortController().signal)
    expect(client.request).toHaveBeenCalledTimes(2)
    expect(client.request.mock.calls[0][1]).toBe('DELETE')
  })
  it('repairs consecutive empty accepted checkpoints, stopping at the last nonempty summary', async () => {
    const client = { request: vi.fn() }
    const history = entries('valid earlier summary')
    for (const suffix of ['one', 'two'])
      history.push(
        ...entries()
          .slice(1)
          .map((entry) => ({
            ...entry,
            info: {
              ...entry.info,
              id: `${entry.info.id}-${suffix}`,
              parentID: entry.info.parentID ? `${entry.info.parentID}-${suffix}` : undefined
            }
          }))
      )
    expect(await discardEmptyNativeCompaction(client, 'session', history, new AbortController().signal)).toBe(true)
    const deleted = client.request.mock.calls.map(([route]) => route)
    expect(deleted).toHaveLength(4)
    expect(deleted).toContain('/session/session/message/summary-two')
    expect(deleted).toContain('/session/session/message/summary-one')
    expect(deleted).not.toContain('/session/session/message/summary')
  })
  it('leaves unknown history untouched and propagates repair failures instead of claiming success', async () => {
    const client = { request: vi.fn() }
    const unknown = entries()
    unknown[2].info.parentID = 'missing'
    await expect(
      discardEmptyNativeCompaction(client, 'session', unknown, new AbortController().signal)
    ).rejects.toThrow('no history was changed')
    expect(client.request).not.toHaveBeenCalled()
    client.request.mockRejectedValue(new Error('disk failure'))
    await expect(
      discardEmptyNativeCompaction(client, 'session', entries(), new AbortController().signal)
    ).rejects.toThrow('disk failure')
    expect(client.request).toHaveBeenCalledTimes(1)
  })
})
