import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'

import {
  type AssistantFileResult,
  isAssistantFileOutputToolName,
  parseAssistantFileResults
} from './Tools/MessageAgentTools/AssistantCreateFileTool'

export function localArtifactKey(path: string): string {
  return /^[a-z]:[\\/]/i.test(path) ? path.replace(/\\/g, '/').toLowerCase() : path
}

// Only structured, completed output tools may publish shortcuts. Never mine
// prompts, shell commands, arbitrary Markdown paths or input attachments.
export function collectMessageArtifacts(blocks: (MessageBlock | undefined)[]): AssistantFileResult[] {
  const outputs = new Map<string, AssistantFileResult>()
  for (const block of blocks) {
    if (block?.type !== MessageBlockType.TOOL || block.status !== MessageBlockStatus.SUCCESS) continue
    const response = block.metadata?.rawMcpToolResponse
    if (!response || response.status !== 'done' || response.response?.isError === true) continue
    if (!isAssistantFileOutputToolName(response.tool.name) && !isAssistantFileOutputToolName(response.tool.id)) continue
    for (const artifact of parseAssistantFileResults(response.response)) {
      // Schemes, relative paths and network shares must not become shell-open shortcuts.
      if (
        !/^(?:[a-z]:[\\/]|\/(?!\/))/i.test(artifact.path) ||
        artifact.path.includes('\0') ||
        /[\r\n]/.test(artifact.path)
      )
        continue
      const key = localArtifactKey(artifact.path)
      outputs.set(key, { ...outputs.get(key), ...artifact })
    }
  }
  return [...outputs.values()]
}

export type SessionArtifact = AssistantFileResult & { messageId: string; turn: number; occurrences: number }

/** Rebuild from this conversation's persisted blocks; no disk scan or new storage. */
export function collectSessionArtifacts(messages: Message[], blocks: Record<string, MessageBlock | undefined>) {
  const outputs = new Map<string, SessionArtifact>()
  let turn = 0
  for (const message of messages) {
    if (message.role === 'user') turn++
    if (message.role !== 'assistant') continue
    for (const artifact of collectMessageArtifacts(message.blocks.map((id) => blocks[id]))) {
      const key = localArtifactKey(artifact.path)
      const previous = outputs.get(key)
      outputs.delete(key)
      outputs.set(key, {
        ...previous,
        ...artifact,
        messageId: message.id,
        turn,
        occurrences: (previous?.occurrences ?? 0) + 1
      })
    }
  }
  return [...outputs.values()].reverse()
}
