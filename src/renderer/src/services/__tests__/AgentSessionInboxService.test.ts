import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/store', () => ({ default: {} }))
vi.mock('@renderer/store/newMessage', () => ({ newMessagesActions: {}, selectMessagesForTopic: vi.fn() }))
vi.mock('@renderer/store/thunk/messageThunk', () => ({ sendMessage: vi.fn(), saveMessageAndBlocksToDB: vi.fn() }))
vi.mock('../FileManager', () => ({ default: {} }))

import {
  type AgentInboxEntry,
  type AgentInboxPayload,
  AgentSessionInbox,
  type InboxDependencies
} from '../AgentSessionInboxService'

function payload(id = 'one', sessionId = 'session'): AgentInboxPayload {
  return {
    text: id,
    files: [],
    args: [{ id }, [], {}, `session:${sessionId}`, { agentId: DEFAULT_OPENCODE_AGENT_ID, sessionId }] as any
  }
}
function fixture(restored: AgentInboxEntry[] = []) {
  let stored = restored
  const deps: InboxDependencies = {
    read: () => stored,
    write: vi.fn((entries) => {
      stored = JSON.parse(JSON.stringify(entries))
    }),
    busy: vi.fn(() => false),
    failed: vi.fn(() => undefined),
    send: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn(async (entry) => ({ id: entry.id, state: 'accepted' })),
    check: vi.fn(async (entry) => ({ id: entry.id, state: 'applied' })),
    status: vi.fn().mockResolvedValue({ active: false, ready: false }),
    accepted: vi.fn().mockResolvedValue(undefined)
  }
  return { inbox: new AgentSessionInbox(deps), deps, stored: () => stored }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('assistant follow-up outbox', () => {
  it('guides the selected queued message with the original ID and attachments exactly once', async () => {
    const { inbox, deps } = fixture()
    vi.mocked(deps.busy).mockReturnValue(true)
    const original = { ...payload('selected'), files: [{ id: 'attachment', path: '/paper.pdf' }] as any }
    inbox.add(payload('first'), 'queue')
    inbox.add(original, 'queue')
    const promoted = inbox.guide('selected')
    expect(await inbox.guide('selected')).toBe('unavailable')
    expect(await promoted).toBe('submitted')
    await inbox.flush()
    expect(deps.steer).toHaveBeenCalledTimes(1)
    expect(deps.steer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'selected',
        text: original.text,
        files: original.files,
        args: original.args
      })
    )
    expect(inbox.snapshot().map(({ id, delivery, state }) => ({ id, delivery, state }))).toEqual([
      { id: 'first', delivery: 'queue', state: 'queued' },
      { id: 'selected', delivery: 'steer', state: 'accepted' }
    ])
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('retains queued work if persisting the guide action fails before submission', async () => {
    const { inbox, deps, stored } = fixture()
    inbox.add(payload(), 'queue')
    vi.mocked(deps.write).mockImplementationOnce(() => {
      throw new Error('storage full')
    })
    await expect(inbox.guide('one')).rejects.toThrow('storage full')
    expect(inbox.snapshot()[0]).toMatchObject({ delivery: 'queue', state: 'queued' })
    expect(stored()[0]).toMatchObject({ delivery: 'queue', state: 'queued' })
    expect(deps.steer).not.toHaveBeenCalled()
    await inbox.flush()
    expect(deps.send).toHaveBeenCalledTimes(1)
  })

  it.each(['not_ready', 'not_running'])('keeps a definitely rejected guide queued (%s)', async (code) => {
    const { inbox, deps } = fixture()
    inbox.add(payload(), 'queue')
    vi.mocked(deps.steer).mockResolvedValueOnce({ id: 'one', state: 'rejected', code } as any)
    expect(await inbox.guide('one')).toBe('queued')
    expect(inbox.snapshot()[0]).toMatchObject({ delivery: 'queue', state: 'queued', receipt: undefined })
    await inbox.flush()
    expect(deps.steer).toHaveBeenCalledTimes(1)
    expect(deps.send).toHaveBeenCalledTimes(1)
  })

  it('does not send the promoted entry normally when a prior queue status check finishes late', async () => {
    const { inbox, deps } = fixture()
    inbox.add(payload(), 'queue')
    let finishStatus!: (value: any) => void
    vi.mocked(deps.status).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStatus = resolve
        })
    )
    const flushing = inbox.flush()
    expect(await inbox.guide('one')).toBe('submitted')
    finishStatus({ active: false, ready: false })
    await flushing
    expect(deps.steer).toHaveBeenCalledTimes(1)
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('does not allow guiding a message already admitted through the normal queue', async () => {
    const { inbox, deps } = fixture()
    inbox.add(payload(), 'queue')
    let finish!: () => void
    vi.mocked(deps.send).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const flushing = inbox.flush()
    await vi.waitFor(() => expect(deps.send).toHaveBeenCalledTimes(1))
    expect(await inbox.guide('one')).toBe('unavailable')
    expect(deps.steer).not.toHaveBeenCalled()
    finish()
    await flushing
  })

  it('does not overwrite an in-flight guide when an earlier queue status check fails', async () => {
    const { inbox, deps } = fixture()
    inbox.add(payload(), 'queue')
    let failStatus!: (reason: Error) => void
    vi.mocked(deps.status).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failStatus = reject
        })
    )
    let acceptGuide!: (receipt: any) => void
    vi.mocked(deps.steer).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acceptGuide = resolve
        })
    )
    const flushing = inbox.flush()
    const guiding = inbox.guide('one')
    failStatus(new Error('status response lost'))
    await flushing
    expect(inbox.snapshot()[0]).toMatchObject({ delivery: 'steer', state: 'sending' })
    expect(inbox.isPaused('session')).toBe(false)
    expect(inbox.remove('one')).toBeUndefined()
    acceptGuide({ id: 'one', state: 'accepted' })
    await guiding
    expect(inbox.snapshot()[0]).toMatchObject({ delivery: 'steer', state: 'accepted' })
    expect(deps.send).not.toHaveBeenCalled()
    expect(deps.steer).toHaveBeenCalledTimes(1)
  })

  it('does not return an ambiguous guide to the normal queue or automatically submit it again', async () => {
    const { inbox, deps } = fixture()
    inbox.add(payload(), 'queue')
    vi.mocked(deps.steer).mockRejectedValueOnce(new Error('response lost'))
    await inbox.guide('one')
    await inbox.flush()
    expect(inbox.snapshot()[0]).toMatchObject({ delivery: 'steer', state: 'uncertain' })
    expect(await inbox.guide('one')).toBe('unavailable')
    expect(deps.steer).toHaveBeenCalledTimes(1)
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('waits for the main-process task lease and sends queued entries in order without overlap', async () => {
    const { inbox, deps } = fixture()
    inbox.add(payload('one'), 'queue')
    inbox.add(payload('two'), 'queue')
    vi.mocked(deps.status).mockResolvedValueOnce({ active: true, ready: false })
    await inbox.flush()
    expect(deps.send).not.toHaveBeenCalled()
    let finish!: () => void
    vi.mocked(deps.send).mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    const pending = inbox.flush()
    await vi.waitFor(() => expect(deps.send).toHaveBeenCalledTimes(1))
    await inbox.flush()
    expect(deps.send).toHaveBeenCalledTimes(1)
    finish()
    await pending
    await inbox.flush()
    expect(vi.mocked(deps.send).mock.calls.map(([entry]) => entry.id)).toEqual(['one', 'two'])
  })

  it('preserves queued work across page subscriptions and pauses on stop until explicit resume', async () => {
    const { inbox, deps } = fixture()
    const notify = vi.fn()
    const unsubscribe = inbox.subscribe(notify)
    inbox.add(payload(), 'queue')
    unsubscribe()
    inbox.pause('session')
    await inbox.flush()
    expect(inbox.snapshot()[0].text).toBe('one')
    expect(deps.send).not.toHaveBeenCalled()
    inbox.resume('session')
    await vi.waitFor(() => expect(deps.send).toHaveBeenCalledTimes(1))
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('does not run remaining entries after an error or automatically retry the failed entry', async () => {
    const { inbox, deps } = fixture()
    vi.mocked(deps.send).mockRejectedValueOnce(new Error('tool failed after side effect'))
    inbox.add(payload('one'), 'queue')
    inbox.add(payload('two'), 'queue')
    await inbox.flush()
    await inbox.flush()
    expect(inbox.isPaused('session')).toBe(true)
    expect(inbox.snapshot().map((entry) => entry.state)).toEqual(['failed', 'queued'])
    expect(deps.send).toHaveBeenCalledTimes(1)
    inbox.resume('session')
    await vi.waitFor(() => expect(deps.send).toHaveBeenCalledTimes(2))
    expect(vi.mocked(deps.send).mock.calls[1][0].id).toBe('two')
  })

  it('restores unsent work paused and in-flight work as uncertain without replaying', async () => {
    const original = fixture()
    original.inbox.add(payload('one'), 'queue')
    original.inbox.add(payload('two'), 'steer')
    const { inbox, deps } = fixture(original.stored())
    await inbox.flush()
    expect(inbox.snapshot().map((entry) => entry.state)).toEqual(['queued', 'uncertain'])
    expect(inbox.isPaused('session')).toBe(true)
    expect(deps.send).not.toHaveBeenCalled()
    expect(deps.steer).not.toHaveBeenCalled()
  })

  it('keeps an ambiguous steering result and only checks receipts, never resubmits it', async () => {
    const { inbox, deps } = fixture()
    vi.mocked(deps.steer).mockRejectedValueOnce(new Error('IPC response lost'))
    inbox.add(payload(), 'steer')
    await vi.waitFor(() => expect(inbox.snapshot()[0].state).toBe('uncertain'))
    await inbox.flush()
    await inbox.check('one')
    expect(inbox.snapshot()[0].state).toBe('applied')
    expect(deps.accepted).toHaveBeenCalledTimes(1)
    expect(deps.steer).toHaveBeenCalledTimes(1)
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('requires durable storage before any queued model request', async () => {
    const { inbox, deps } = fixture()
    vi.mocked(deps.write).mockImplementationOnce(() => {
      throw new Error('quota')
    })
    expect(() => inbox.add(payload(), 'queue')).toThrow('quota')
    expect(inbox.snapshot()).toHaveLength(0)
    inbox.add(payload(), 'queue')
    vi.mocked(deps.write).mockImplementation(() => {
      throw new Error('quota')
    })
    await inbox.flush()
    expect(deps.send).not.toHaveBeenCalled()
    expect(inbox.isPaused('session')).toBe(true)
  })

  it('supports editing/removing unsent entries but cannot remove a dispatch in progress', async () => {
    const { inbox, deps } = fixture()
    inbox.add(payload('one'), 'queue')
    expect(inbox.remove('one')?.text).toBe('one')
    vi.mocked(deps.steer).mockImplementation(() => new Promise(() => {}))
    inbox.add(payload('two'), 'steer')
    expect(inbox.remove('two')).toBeUndefined()
    expect(inbox.snapshot()).toHaveLength(1)
  })
})
