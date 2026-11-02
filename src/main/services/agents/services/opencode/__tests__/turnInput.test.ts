import type { AgentRunInput } from '@shared/agents/sessionInput'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkAgentRunInput, getAgentRunInputStatus, OpenCodeTurnInput, submitAgentRunInput } from '../turnInput'

let sequence = 0
const controllers: OpenCodeTurnInput[] = []
function fixture() {
  const sessionId = `input-test-${++sequence}`
  const request = vi.fn().mockResolvedValue(undefined)
  const abort = new AbortController()
  const body = { agent: 'zen', model: { providerID: 'selected', modelID: 'model' }, system: 'instructions' }
  const controller = new OpenCodeTurnInput(
    sessionId,
    'msg_000000000000initial',
    { request },
    'native',
    body,
    abort.signal
  )
  controllers.push(controller)
  const input: AgentRunInput = { sessionId, turnId: controller.turnId, id: 'addition', text: '改为中文回答' }
  return { sessionId, request, abort, body, controller, input }
}
afterEach(() => controllers.splice(0).forEach((controller) => controller.close()))

describe('native active-task input', () => {
  it('rejects stale and starting turns without creating another native task', async () => {
    const { sessionId, request, controller, input } = fixture()
    expect(getAgentRunInputStatus(sessionId)).toMatchObject({ active: true, ready: false })
    expect(await submitAgentRunInput(input)).toMatchObject({ state: 'rejected', code: 'not_ready' })
    controller.ready(true)
    expect(await submitAgentRunInput({ ...input, turnId: 'older-turn' })).toMatchObject({ code: 'not_running' })
    expect(request).not.toHaveBeenCalled()
  })

  it('submits once into the same session, retaining the active model and attachments', async () => {
    const { request, controller, input, body } = fixture()
    controller.ready(true)
    const receipt = await submitAgentRunInput({ ...input, images: [{ data: 'aW1hZ2U=', media_type: 'image/png' }] })
    expect(receipt.state).toBe('accepted')
    expect(request).toHaveBeenCalledExactlyOnceWith(
      '/session/native/prompt_async',
      'POST',
      {
        ...body,
        messageID: receipt.nativeMessageId,
        parts: [
          { type: 'text', text: input.text },
          { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aW1hZ2U=' }
        ]
      },
      expect.any(AbortSignal)
    )
  })

  it('deduplicates concurrent submissions and refuses reuse with different content', async () => {
    const { request, controller, input } = fixture()
    controller.ready(true)
    let complete!: () => void
    request.mockImplementation(() => new Promise<void>((resolve) => (complete = resolve)))
    const first = submitAgentRunInput(input)
    const second = submitAgentRunInput(input)
    complete()
    expect(await first).toEqual(await second)
    expect(await submitAgentRunInput({ ...input, text: 'different task' })).toMatchObject({ code: 'invalid_input' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not retry an ambiguous POST, and later reconciles its durable receipt', async () => {
    const { request, controller, input, sessionId } = fixture()
    controller.ready(true)
    request.mockImplementation(async (route) => {
      if (route.endsWith('/prompt_async')) throw new Error('response lost')
      return []
    })
    const receipt = await submitAgentRunInput(input)
    expect(receipt.state).toBe('uncertain')
    expect(await submitAgentRunInput(input)).toEqual(receipt)
    request.mockResolvedValue([{ info: { id: receipt.nativeMessageId, role: 'user' } }])
    expect(await checkAgentRunInput(sessionId, input.id)).toMatchObject({ state: 'accepted' })
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })

  it('separates accepted, consumed, and deferred additions at the native idle boundary', async () => {
    const { controller, input } = fixture()
    controller.ready(true)
    const first = await controller.submit(input)
    const second = await controller.submit({ ...input, id: 'second', text: '再增加费用表' })
    const third = await controller.submit({ ...input, id: 'third', text: '最后补充一句' })
    const messages = [first, second, third].map((receipt) => ({ info: { id: receipt.nativeMessageId!, role: 'user' } }))
    controller.reconcile(messages)
    expect(await controller.submit(input)).toMatchObject({ state: 'accepted' })
    messages.push({ info: { id: 'assistant', role: 'assistant', parentID: second.nativeMessageId } } as any)
    controller.reconcile(messages, true)
    expect(await controller.submit(input)).toMatchObject({ state: 'applied' })
    expect(await controller.check('second')).toMatchObject({ state: 'applied' })
    expect(await controller.check('third')).toMatchObject({ state: 'deferred' })
  })

  it('keeps receipts after closing but rejects new input, including after cancellation', async () => {
    const { controller, abort, input, sessionId } = fixture()
    controller.ready(true)
    const receipt = await controller.submit(input)
    abort.abort()
    expect(controller.status()).toMatchObject({ active: false, ready: false })
    controller.close()
    expect(await submitAgentRunInput(input)).toEqual(receipt)
    expect(await submitAgentRunInput({ ...input, id: 'later' })).toMatchObject({ code: 'not_running' })
    expect(await checkAgentRunInput(sessionId, 'unknown-after-restart')).toMatchObject({
      state: 'uncertain',
      code: 'receipt_unavailable'
    })
  })
})
