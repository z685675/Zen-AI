import type { AgentPersistedMessage } from '@renderer/types/agent'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { IpcChannel } from '@shared/IpcChannel'

/** Repair missing historical blocks from storage; never replay a task or include other turns. */
export async function diagnosticHistorySnapshot(message: Message, entities: Record<string, MessageBlock | undefined>) {
  if (!message.topicId.startsWith('agent-session:') || !['success', 'error', 'paused'].includes(message.status)) {
    return { entities, status: 'not-applicable' }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const history: AgentPersistedMessage[] = await Promise.race([
      window.electron.ipcRenderer.invoke(IpcChannel.AgentMessage_GetHistory, {
        sessionId: message.topicId.slice('agent-session:'.length)
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed-out')), 3000)
      })
    ])
    const persisted = history?.find((item) => item.message?.id === message.id)
    if (!persisted || persisted.message.status !== message.status) return { entities, status: 'unavailable' }
    const currentId = message.providerMetadata?.zenDiagnostic?.operationId
    const storedId = persisted.message.providerMetadata?.zenDiagnostic?.operationId
    if (currentId && storedId && currentId !== storedId) return { entities, status: 'different-operation' }
    if (
      (!currentId || !storedId) &&
      message.updatedAt &&
      persisted.message.updatedAt &&
      message.updatedAt !== persisted.message.updatedAt
    )
      return { entities, status: 'different-snapshot' }
    const merged = { ...entities }
    for (const block of persisted.blocks ?? []) {
      if (block.messageId !== message.id || !message.blocks.includes(block.id)) continue
      const current = merged[block.id]
      if (
        !current ||
        (['pending', 'streaming', 'processing'].includes(current.status) &&
          ['success', 'error', 'paused'].includes(block.status))
      ) {
        merged[block.id] = block
      }
    }
    return { entities: merged, operationId: storedId, status: 'collected-selected-turn' }
  } catch {
    return { entities, status: 'unavailable-or-timed-out' }
  } finally {
    clearTimeout(timer)
  }
}
