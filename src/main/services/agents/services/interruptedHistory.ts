import type { AgentPersistedMessage } from '@types'

const pendingMessages = new Set(['pending', 'processing', 'searching'])
const pendingBlocks = new Set(['pending', 'processing', 'streaming'])

/** Display-state repair only. Preserve native history; never replay tools or prompts. */
export function repairInterruptedHistory(
  payload: AgentPersistedMessage,
  startedAt: number,
  currentRunId?: string
): AgentPersistedMessage {
  const message = payload.message
  if (
    message?.role !== 'assistant' ||
    !pendingMessages.has(message.status) ||
    (currentRunId
      ? message.providerMetadata?.zenAppRun?.id === currentRunId
      : !Number.isFinite(Date.parse(message.createdAt)) || Date.parse(message.createdAt) >= startedAt)
  )
    return payload
  return {
    ...payload,
    message: {
      ...message,
      status: 'paused' as AgentPersistedMessage['message']['status'],
      providerMetadata: {
        ...message.providerMetadata,
        zenInterrupted: {
          reason: 'previous-app-run',
          observedAt: new Date(startedAt).toISOString(),
          automaticReplay: false
        }
      }
    },
    blocks: (payload.blocks ?? []).map((block) => {
      if (!pendingBlocks.has(block.status)) return block
      const tool = block.type === 'tool' ? block.metadata?.rawMcpToolResponse : undefined
      return {
        ...block,
        status: 'paused' as typeof block.status,
        ...(tool && !['done', 'error', 'cancelled'].includes(tool.status)
          ? {
              metadata: { ...block.metadata, rawMcpToolResponse: { ...tool, status: 'cancelled' } }
            }
          : {})
      }
    })
  }
}
