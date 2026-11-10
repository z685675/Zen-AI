import { describe, expect, it, vi } from 'vitest'

import type { DshHistory } from '../../../../dshPreview/runtime'
import { checkDshRunInput, DshTurnInput, ownsDshRunInput } from '../turnInput'

describe('DSH steering admission', () => {
  it('deduplicates parallel submissions and requires native evidence before applied', async () => {
    const history: DshHistory = { sessionId: 'native', events: [] }
    const runtime = { call: vi.fn(async () => ({})), snapshot: () => history }
    const turn = new DshTurnInput('steer-once', runtime, new AbortController().signal)
    turn.ready(true)
    const input = { sessionId: 'steer-once', turnId: turn.turnId, id: 'addition', text: 'Use the revised title' }
    const [first, second] = await Promise.all([turn.submit(input), turn.submit(input)])
    expect(runtime.call).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(first.state).toBe('accepted')
    history.events.push({ type: 'user/message', seq: 0, data: { id: first.nativeMessageId } })
    expect((await turn.check(input.id)).state).toBe('accepted')
    history.events.push({ type: 'assistant/message', seq: 1, data: {} })
    expect((await turn.check(input.id)).state).toBe('applied')
    expect(await turn.submit({ ...input, text: 'different input' })).toMatchObject({
      state: 'rejected',
      code: 'invalid_input'
    })
    await turn.close()
    expect(ownsDshRunInput('steer-once')).toBe(true)
    expect((await checkDshRunInput('steer-once', input.id)).state).toBe('applied')
  })

  it('leaves ambiguous transport delivery uncertain without retrying the native call', async () => {
    const runtime = {
      call: vi.fn(async () => {
        throw new Error('pipe lost after write')
      }),
      snapshot: () => ({ sessionId: 'native', events: [] })
    }
    const turn = new DshTurnInput('steer-uncertain', runtime, new AbortController().signal)
    turn.ready(true)
    const input = { sessionId: 'steer-uncertain', turnId: turn.turnId, id: 'addition', text: 'Stop after this step' }
    expect(await turn.submit(input)).toMatchObject({ state: 'uncertain', code: 'delivery_uncertain' })
    await turn.submit(input)
    await turn.close()
    expect(runtime.call).toHaveBeenCalledTimes(1)
  })

  it('marks durably queued but unprocessed input deferred when the run closes', async () => {
    const history: DshHistory = { sessionId: 'native', events: [] }
    const turn = new DshTurnInput(
      'steer-deferred',
      { call: vi.fn(async () => ({})), snapshot: () => history },
      new AbortController().signal
    )
    turn.ready(true)
    const receipt = await turn.submit({
      sessionId: 'steer-deferred',
      turnId: turn.turnId,
      id: 'later',
      text: 'Also make a summary'
    })
    history.events.push({ type: 'agent/inbox/spliced', seq: 0, data: { inserted: [{ id: receipt.nativeMessageId }] } })
    await turn.close()
    expect(await turn.check('later')).toMatchObject({ state: 'deferred' })
  })
})
