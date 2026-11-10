import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { IpcChannel } from '@shared/IpcChannel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentMessageDataSource } from '../AgentMessageDataSource'

const harness = vi.hoisted(() => ({ state: { messages: { entities: {} }, messageBlocks: { entities: {} } } as any }))
vi.mock('@renderer/store', () => ({ default: { getState: () => harness.state } }))

const originalElectron = window.electron
beforeEach(() => {
  harness.state = { messages: { entities: {} }, messageBlocks: { entities: {} } }
})
afterEach(() => {
  Object.assign(window, { electron: originalElectron })
})

describe('agent terminal snapshot persistence', () => {
  it('orders a slow streaming write before the complete snapshot, and prevents a late pending result from erasing file delivery', async () => {
    const topicId = 'agent-session:persistence'
    const message = {
      id: 'completed-file-turn',
      topicId,
      role: 'assistant',
      status: 'processing',
      blocks: ['delivery'],
      providerMetadata: { zenDiagnostic: { operationId: 'operation-one' } }
    } as Message
    const pending = { id: 'delivery', messageId: message.id, type: 'tool', status: 'pending' } as MessageBlock
    let persisted: any
    let release!: () => void
    let delay = false
    const invoke = vi.fn(async (channel: string, payload: any) => {
      if (channel === IpcChannel.AgentMessage_GetHistory) return persisted ? [persisted] : []
      if (delay) {
        delay = false
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      persisted = structuredClone(payload.assistant.payload)
    })
    Object.assign(window, { electron: { ipcRenderer: { invoke } } })
    const source = new AgentMessageDataSource()
    harness.state.messages.entities[message.id] = message
    harness.state.messageBlocks.entities.delivery = pending
    await source.appendMessage(topicId, message, [pending])
    delay = true
    const earlier = source.updateBlocks([pending])
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const delivered = {
      ...pending,
      status: 'success',
      metadata: {
        rawMcpToolResponse: {
          status: 'done',
          response: { status: 'ready', files: [{ path: 'D:/report.md', verified: true }] }
        }
      }
    } as MessageBlock
    harness.state.messages.entities[message.id] = { ...message, status: 'success' }
    harness.state.messageBlocks.entities.delivery = delivered
    const finishing = source.updateMessageAndBlocks(
      topicId,
      { id: message.id, status: 'success' } as Partial<Message> & Pick<Message, 'id'>,
      [delivered]
    )
    await Promise.resolve()
    expect(invoke.mock.calls.filter(([channel]) => channel === IpcChannel.AgentMessage_PersistExchange)).toHaveLength(2)
    release()
    await Promise.all([earlier, finishing])
    expect(persisted.message.status).toBe('success')
    expect(persisted.blocks[0]).toEqual(delivered)
    await source.updateBlocks([pending])
    expect(persisted.blocks[0]).toEqual(delivered)
  })

  it('does not persist a delayed result over a new operation using the same message ID', async () => {
    const message = {
      id: 'retried-turn',
      topicId: 'agent-session:retry',
      role: 'assistant',
      status: 'success',
      blocks: [],
      providerMetadata: { zenDiagnostic: { operationId: 'old' } }
    } as Message
    harness.state.messages.entities[message.id] = {
      ...message,
      status: 'processing',
      providerMetadata: { zenDiagnostic: { operationId: 'new' } }
    }
    const invoke = vi.fn()
    Object.assign(window, { electron: { ipcRenderer: { invoke } } })
    await new AgentMessageDataSource().appendMessage(message.topicId, message, [])
    expect(invoke).not.toHaveBeenCalled()
  })
})
