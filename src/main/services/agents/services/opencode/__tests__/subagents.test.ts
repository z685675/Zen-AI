import { describe, expect, it, vi } from 'vitest'

import { OpenCodeSubagents } from '../subagents'

function fixture() {
  const controller = new AbortController()
  const publish = vi.fn()
  const request = vi.fn(async (route: string) =>
    route === '/session/child' ? { id: 'child', parentID: 'root' } : { id: 'stranger', parentID: 'another-root' }
  )
  const tree = new OpenCodeSubagents({ request } as any, 'root', 'zen', controller.signal, publish)
  return { tree, controller, publish, request }
}

describe('native subagent turn ownership and admission', () => {
  it('does not create a free slot when a queued native task fails before admission', async () => {
    const { tree } = fixture()
    await tree.admit('one', 'one', 'general')
    await tree.admit('two', 'two', 'general')
    const third = tree.admit('three', 'three', 'general')
    tree.finish('three', 'failed')
    expect(await third).toBe(false)
    const fourth = tree.admit('four', 'four', 'general')
    tree.finish('one', 'completed')
    expect(await fourth).toBe(true)
    tree.close()
  })
  it('clears queued work at an interrupted native run barrier and permits a later continuation', async () => {
    const { tree } = fixture()
    await tree.admit('one', 'one', 'general')
    await tree.admit('two', 'two', 'general')
    const queued = tree.admit('three', 'three', 'general')
    tree.cancelCurrent()
    expect(await queued).toBe(false)
    expect(tree.unfinished).toBe(false)
    expect(await tree.admit('new-continuation', 'Continue missing work', 'general')).toBe(true)
    tree.close()
  })
  it('queues the third delegation and reserves a released slot before admitting new work', async () => {
    const { tree, publish } = fixture()
    expect(await tree.admit('one', 'Research A', 'general')).toBe(true)
    expect(await tree.admit('two', 'Research B', 'explore')).toBe(true)
    const third = tree.admit('three', 'Research C', 'general')
    expect(publish.mock.calls.at(-1)?.[0].at(-1).status).toBe('queued')
    tree.finish('one', 'completed')
    const fourth = tree.admit('four', 'Research D', 'general')
    expect(await third).toBe(true)
    expect(publish.mock.calls.at(-1)?.[0].find((item: any) => item.id === 'four').status).toBe('queued')
    tree.finish('two', 'completed')
    expect(await fourth).toBe(true)
    tree.close()
  })

  it('cancels queued admissions and never grants unsupported agents or unlimited launches', async () => {
    const { tree, controller, publish } = fixture()
    expect(await tree.admit('custom', 'unknown', 'unknown')).toBe(false)
    await tree.admit('one', 'one', 'general')
    await tree.admit('two', 'two', 'general')
    const third = tree.admit('three', 'three', 'general')
    controller.abort('user cancelled')
    expect(await third).toBe(false)
    tree.close()
    expect(publish.mock.calls.at(-1)?.[0].every((item: any) => item.status === 'cancelled')).toBe(true)
    expect(await tree.admit('four', 'four', 'general')).toBe(false)
  })

  it('accepts only authenticated direct children of this parent and namespaces their permissions', async () => {
    const { tree } = fixture()
    expect(await tree.owns('root')).toBe(true)
    expect(await tree.owns('child')).toBe(true)
    expect(await tree.owns('stranger')).toBe(false)
    expect(tree.toolCallPrefix('child')).toBe('zen:child:child')
    tree.close()
  })

  it('links parent task state, child progress and a failed result without confusing the parent answer', async () => {
    const { tree, publish } = fixture()
    await tree.admit('zen:call', 'Read sources', 'general')
    await tree.observeParent({
      type: 'tool',
      tool: 'task',
      callID: 'call',
      state: { status: 'running', metadata: { sessionId: 'child' } }
    })
    tree.child({ type: 'message.updated', properties: { info: { id: 'message', role: 'assistant' } } }, 'child')
    const chunks = tree.child(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            id: 'read-part',
            messageID: 'message',
            tool: 'read',
            callID: 'read-call',
            state: { status: 'running', input: {} }
          }
        }
      },
      'child'
    )
    expect(chunks[0]).toMatchObject({ type: 'tool-call', toolCallId: 'zen:child:child:read-call' })
    expect(publish.mock.calls.at(-1)?.[0][0]).toMatchObject({ toolCalls: 1, lastTool: 'read' })
    tree.waitingFor('child', 'waiting_permission')
    expect(publish.mock.calls.at(-1)?.[0][0].status).toBe('waiting_permission')
    await tree.observeParent({ type: 'tool', tool: 'task', callID: 'call', state: { status: 'error' } })
    expect(tree.unfinished).toBe(false)
    expect(publish.mock.calls.at(-1)?.[0][0].status).toBe('failed')
    tree.close()
  })

  it('bounds the total delegation count even when every child finishes immediately', async () => {
    const { tree } = fixture()
    for (let index = 0; index < 16; index++) {
      expect(await tree.admit(String(index), 'Work', 'general')).toBe(true)
      tree.finish(String(index), 'completed')
    }
    expect(await tree.admit('extra', 'Work', 'general')).toBe(false)
    tree.close()
  })

  it("recovers missed child results and usage once without exposing prose or a resumed child's older work", async () => {
    const { tree, request, publish } = fixture()
    await tree.admit('zen:call', 'Read sources', 'general')
    await tree.observeParent({
      type: 'tool',
      tool: 'task',
      callID: 'call',
      state: { status: 'completed', metadata: { sessionId: 'child' } }
    })
    request.mockImplementation(
      async () =>
        [
          {
            info: {
              id: 'old-message',
              role: 'assistant',
              time: { created: 1 },
              tokens: { input: 999, output: 999 }
            },
            parts: []
          },
          {
            info: {
              id: 'message',
              role: 'assistant',
              time: { created: Date.now() },
              tokens: { input: 20, output: 8 }
            },
            parts: [
              { id: 'prose', type: 'text', messageID: 'message', text: 'Private findings', time: { end: 1 } },
              {
                id: 'question-part',
                type: 'tool',
                messageID: 'message',
                tool: 'question',
                callID: 'question-call',
                state: { status: 'completed', input: { questions: [] }, output: 'User chose PDF' }
              }
            ]
          }
        ] as any
    )
    expect(await tree.reconcile()).toEqual([
      expect.objectContaining({ type: 'tool-call', toolCallId: 'zen:child:child:question-call' }),
      expect.objectContaining({ type: 'tool-result', output: 'User chose PDF' })
    ])
    expect(await tree.reconcile()).toEqual([])
    expect(tree.usages()[0]).toMatchObject({ inputTokens: 20, outputTokens: 8 })
    expect(publish.mock.calls.at(-1)?.[0][0]).toMatchObject({ toolCalls: 1, lastTool: 'question' })
    tree.close()
  })

  it('does not fail an otherwise complete parent when optional child history cannot be read', async () => {
    const { tree, request } = fixture()
    await tree.owns('child')
    request.mockRejectedValue(new Error('local history unavailable'))
    expect(await tree.reconcile()).toEqual([])
    tree.close()
  })
})
