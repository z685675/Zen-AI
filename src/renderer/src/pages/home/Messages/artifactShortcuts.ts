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

type RegisteredArtifact = AssistantFileResult & { registrationId: string }

// Only structured, completed output tools may publish shortcuts. Never mine
// prompts, shell commands, arbitrary Markdown paths or input attachments.
export function collectMessageArtifacts(blocks: (MessageBlock | undefined)[]): AssistantFileResult[] {
  return collectMessageArtifactSet(blocks).artifacts
}

function collectMessageArtifactSet(blocks: (MessageBlock | undefined)[]) {
  const outputs = new Map<string, RegisteredArtifact>()
  let final = false
  for (const block of blocks) {
    if (block?.type !== MessageBlockType.TOOL || block.status !== MessageBlockStatus.SUCCESS) continue
    const response = block.metadata?.rawMcpToolResponse
    if (!response || response.status !== 'done' || response.response?.isError === true) continue
    if (!isAssistantFileOutputToolName(response.tool.name) && !isAssistantFileOutputToolName(response.tool.id)) continue
    const artifacts = parseAssistantFileResults(response.response).filter((artifact) => {
      // Schemes, relative paths and network shares must not become shell-open shortcuts.
      return (
        /^(?:[a-z]:[\\/]|\/(?!\/))/i.test(artifact.path) &&
        !artifact.path.includes('\0') &&
        !/[\r\n]/.test(artifact.path)
      )
    })
    // Ordinary registrations may be partial batches. Only an explicit, successful
    // complete manifest replaces intermediate shortcuts in this user turn.
    if (
      [response.tool.name, response.tool.id].some((name) => name?.toLowerCase().endsWith('present_files')) &&
      artifacts.some((artifact) => artifact.final)
    ) {
      outputs.clear()
      final = true
    }
    for (const artifact of artifacts) {
      const key = localArtifactKey(artifact.path)
      outputs.set(key, { ...outputs.get(key), ...artifact, registrationId: block.id })
    }
  }
  return { artifacts: [...outputs.values()], final }
}

export type SessionArtifact = RegisteredArtifact & { messageId: string; turn: number; occurrences: number }

/** Rebuild from this conversation's persisted blocks; no disk scan or new storage. */
export function collectSessionArtifacts(messages: Message[], blocks: Record<string, MessageBlock | undefined>) {
  const outputs = new Map<string, SessionArtifact>()
  const turnOutputs = new Map<string, SessionArtifact>()
  let turn = 0
  const finishTurn = () => {
    for (const [key, artifact] of turnOutputs) {
      const previous = outputs.get(key)
      outputs.delete(key)
      outputs.set(key, { ...artifact, occurrences: (previous?.occurrences ?? 0) + artifact.occurrences })
    }
    turnOutputs.clear()
  }
  for (const message of messages) {
    if (message.role === 'user') {
      finishTurn()
      turn++
    }
    if (message.role !== 'assistant') continue
    const collected = collectMessageArtifactSet(message.blocks.map((id) => blocks[id]))
    if (collected.final) turnOutputs.clear()
    for (const artifact of collected.artifacts) {
      const key = localArtifactKey(artifact.path)
      const previous = turnOutputs.get(key)
      turnOutputs.delete(key)
      turnOutputs.set(key, {
        ...previous,
        ...artifact,
        messageId: message.id,
        turn,
        occurrences: (previous?.occurrences ?? 0) + 1
      })
    }
  }
  finishTurn()
  return [...outputs.values()].reverse()
}

/** Limit final-manifest replacement to the user turn containing this message. */
export function artifactTurnMessages(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((item) => item.id === message.id)
  if (index < 0) return [message]
  let start = index
  while (start > 0 && messages[start].role !== 'user') start--
  let end = index + 1
  while (end < messages.length && messages[end].role !== 'user') end++
  return messages.slice(start, end)
}
