import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'

/** Only native skill tool events are evidence. Text mentions / enabled flags are not. */
export function currentTurnSkillUsage(messages: Message[], blocks: Record<string, MessageBlock | undefined>) {
  const lastUser = messages.findLastIndex((message) => message.role === 'user')
  const usage = new Map<string, string>()
  if (lastUser < 0) return usage
  for (const message of messages.slice(lastUser + 1)) {
    if (message.role !== 'assistant') continue
    for (const id of message.blocks) {
      const block = blocks[id]
      if (block?.type !== MessageBlockType.TOOL) continue
      const response = block.metadata?.rawMcpToolResponse
      if ((response?.tool.name ?? block.toolName) !== 'skill') continue
      const input = response?.arguments ?? block.arguments
      const name = input && typeof input === 'object' && !Array.isArray(input) ? input.name : undefined
      if (typeof name !== 'string') continue
      // A pending authorization or streamed argument is not an actual call yet.
      if (response && ['pending', 'streaming'].includes(response.status)) continue
      usage.set(name, response?.status ?? block.status)
    }
  }
  return usage
}
