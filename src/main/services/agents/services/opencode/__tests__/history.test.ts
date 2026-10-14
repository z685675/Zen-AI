import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), bind: vi.fn(), request: vi.fn(), release: vi.fn() }))
vi.mock('../prepare', () => ({ prepareOpenCodeRuntime: mocks.prepare }))

import { editNativeHistory, planNativeHistory } from '../history'

const native = () => [
  { info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'first' }] },
  { info: { id: 'a1', role: 'assistant', parentID: 'u1' }, parts: [{ type: 'tool' }] },
  { info: { id: 'a2', role: 'assistant', parentID: 'u1' }, parts: [{ type: 'text' }] },
  { info: { id: 'u2', role: 'user' }, parts: [{ type: 'text', text: 'second' }] },
  { info: { id: 'a3', role: 'assistant', parentID: 'u2' }, parts: [{ type: 'text' }] }
]
const display = () =>
  [
    {
      message: { id: 'zen-u1', role: 'user', blocks: [], providerMetadata: { opencode: { user_message_id: 'u1' } } },
      blocks: []
    },
    { message: { id: 'zen-a1', role: 'assistant', askId: 'zen-u1', blocks: [] }, blocks: [] },
    {
      message: { id: 'zen-u2', role: 'user', blocks: [], providerMetadata: { opencode: { user_message_id: 'u2' } } },
      blocks: []
    },
    { message: { id: 'zen-a2', role: 'assistant', askId: 'zen-u2', blocks: [] }, blocks: [] }
  ] as any
beforeEach(() => {
  vi.clearAllMocks()
  mocks.bind.mockResolvedValue(undefined)
  mocks.prepare.mockResolvedValue({
    session: async () => 'source',
    bindSession: mocks.bind,
    release: mocks.release,
    client: { request: mocks.request }
  })
  mocks.request.mockImplementation(async (route: string) => {
    if (route === '/session/source/message') return native()
    if (route.endsWith('/fork')) return { id: 'copy' }
    if (route === '/session/copy/message')
      return native().map((entry) => ({ ...entry, info: { ...entry.info, id: `copy-${entry.info.id}` } }))
    return true
  })
})
describe('native conversation operations', () => {
  it('branches at the selected answer and includes all tool steps in that turn', () => {
    expect(planNativeHistory(native(), display(), 'zen-a1', 'fork')).toMatchObject({
      cutoff: 3,
      keepDisplay: display().slice(0, 2)
    })
  })
  it('retries from before the question and discards later display history', () => {
    expect(planNativeHistory(native(), display(), 'zen-a1', 'retry')).toMatchObject({
      cutoff: 0,
      keepDisplay: display().slice(0, 1)
    })
  })
  it('deletes a whole native assistant turn but retains later questions and answers', () => {
    const plan = planNativeHistory(native(), display(), 'zen-a1', 'delete')
    expect(plan.remove).toEqual(['a1', 'a2'])
    expect(plan.keepDisplay.map((item) => item.message.id)).toEqual(['zen-u1', 'zen-u2', 'zen-a2'])
  })
  it('deletes question and related tool/reply messages together', () => {
    expect(planNativeHistory(native(), display(), 'zen-u1', 'delete').remove).toEqual(['u1', 'a1', 'a2'])
    expect(planNativeHistory(native(), display(), 'zen-u1', 'delete').keepDisplay).toEqual(display().slice(2))
  })
  it('invalidates later compaction summaries so deleted text cannot survive in memory', () => {
    const entries = [
      ...native(),
      { info: { id: 'compact', role: 'user' }, parts: [{ type: 'compaction' }] },
      { info: { id: 'summary', role: 'assistant', summary: true }, parts: [{ type: 'text' }] }
    ]
    expect(planNativeHistory(entries, display(), 'zen-a1', 'delete').remove).toEqual(['a1', 'a2', 'compact', 'summary'])
  })
  it('migrates old preview history only when normal user-turn counts match', () => {
    const old = display()
    old.forEach((item: any) => delete item.message.providerMetadata)
    expect(planNativeHistory(native(), old, 'zen-a1', 'retry').cutoff).toBe(0)
    expect(() => planNativeHistory(native().slice(0, 3), old, 'zen-a1', 'retry')).toThrow('do not match')
  })
  it('allows retrying an unadmitted final question after local startup failure', () => {
    const old = display()
    delete old[2].message.providerMetadata
    const plan = planNativeHistory(native().slice(0, 3), old, 'zen-a2', 'retry')
    expect(plan.cutoff).toBe(3)
    expect(plan.keepDisplay).toHaveLength(3)
  })
  it('uses a copy and real native delete APIs, preserves the original and remaps IDs', async () => {
    const commit = vi.fn().mockResolvedValue(undefined)
    const input = display()
    await editNativeHistory({} as any, input, 'zen-a1', 'delete', commit)
    expect(mocks.request).toHaveBeenCalledWith(
      '/session/copy/message/copy-a1',
      'DELETE',
      undefined,
      expect.any(AbortSignal)
    )
    expect(mocks.request).toHaveBeenCalledWith(
      '/session/copy/message/copy-a2',
      'DELETE',
      undefined,
      expect.any(AbortSignal)
    )
    expect(mocks.request.mock.calls.some(([route]) => route === '/session/source/message/a1')).toBe(false)
    expect(commit.mock.calls[0][0][0].message.providerMetadata.opencode).toMatchObject({
      user_message_id: 'copy-u1',
      session_id: 'copy'
    })
    expect(input).toEqual(display())
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it('restores the old binding when display persistence fails', async () => {
    await expect(
      editNativeHistory({} as any, display(), 'zen-a1', 'delete', async () => {
        throw new Error('disk full')
      })
    ).rejects.toThrow('disk full')
    expect(mocks.bind.mock.calls.map(([id]) => id)).toEqual(['copy', 'source'])
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it('does not switch bindings or touch display history after native copy/delete failure', async () => {
    mocks.request.mockRejectedValue(new Error('busy'))
    const commit = vi.fn()
    await expect(editNativeHistory({} as any, display(), 'zen-a1', 'delete', commit)).rejects.toThrow('busy')
    expect(mocks.bind).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it('refuses an incomplete native copy before committing display history', async () => {
    mocks.request.mockImplementation(async (route: string) =>
      route === '/session/source/message' ? native() : route.endsWith('/fork') ? { id: 'copy' } : []
    )
    const commit = vi.fn()
    await expect(editNativeHistory({} as any, display(), 'zen-a1', 'delete', commit)).rejects.toThrow('incomplete')
    expect(commit).not.toHaveBeenCalled()
  })
})
