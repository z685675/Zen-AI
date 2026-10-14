import type { ContextTelemetry } from '@renderer/types'
import {
  AssistantMessageStatus,
  type Message,
  type MessageBlock,
  MessageBlockStatus,
  MessageBlockType
} from '@renderer/types/newMessage'

const STAGE_LABELS: Record<string, string> = {
  connecting: 'new_assistant.connecting',
  starting: 'new_assistant.starting',
  restoring: 'new_assistant.restoring',
  waiting_model: 'new_assistant.waiting_model',
  retrying: 'new_assistant.retrying',
  compacting: 'new_assistant.compacting',
  waiting_permission: 'new_assistant.waiting_permission'
}

export function nativeTaskStage(message: Message, telemetry?: ContextTelemetry): string | undefined {
  const prefix = `opencode-status:${message.id}:`
  return telemetry?.lastAction?.startsWith(prefix) ? telemetry.lastAction.slice(prefix.length) : undefined
}

export function taskProgressLabel(
  message: Message,
  telemetry: ContextTelemetry | undefined,
  t: (key: string) => string
): string {
  const stage = nativeTaskStage(message, telemetry)
  if (stage && STAGE_LABELS[stage]) return t(STAGE_LABELS[stage])
  return t(stage === 'submitting' || stage === 'busy' ? 'new_assistant.waiting_response' : 'new_assistant.preparing')
}

// Received content selects the status wording only. It does not acknowledge that
// the renderer has actually displayed text or a tool yet.
export function hasVisibleAssistantActivity(blocks: (MessageBlock | undefined)[]): boolean {
  return blocks.some((block) => {
    switch (block?.type) {
      case MessageBlockType.MAIN_TEXT:
      case MessageBlockType.THINKING:
      case MessageBlockType.TRANSLATION:
      case MessageBlockType.CODE:
      case MessageBlockType.COMPACT:
        return Boolean(block.content.trim())
      case MessageBlockType.TOOL:
        return Boolean(block.metadata?.rawMcpToolResponse?.tool?.name)
      case MessageBlockType.FILE:
        return Boolean(block.file)
      case MessageBlockType.IMAGE:
        return (
          [MessageBlockStatus.STREAMING, MessageBlockStatus.SUCCESS].includes(block.status) &&
          Boolean(block.file || block.url || block.metadata?.generateImageResponse?.images?.length)
        )
      case MessageBlockType.VIDEO:
        return Boolean(block.url || block.filePath)
      case MessageBlockType.ERROR:
        return Boolean(block.error)
      default:
        return false
    }
  })
}

export function isTaskProgressVisible(message: Message, loading: boolean, hasRenderedContent: boolean): boolean {
  return (
    loading &&
    message.role === 'assistant' &&
    ![AssistantMessageStatus.SUCCESS, AssistantMessageStatus.ERROR, AssistantMessageStatus.PAUSED].includes(
      message.status as AssistantMessageStatus
    ) &&
    !hasRenderedContent
  )
}

export function taskElapsedSeconds(message: Message, now: number): number {
  const start = Date.parse(message.providerMetadata?.responseTiming?.startedAt ?? message.createdAt)
  return Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0
}
