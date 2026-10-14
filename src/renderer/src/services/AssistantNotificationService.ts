import i18n from '@renderer/i18n'
import store from '@renderer/store'
import type { Message } from '@renderer/types/newMessage'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'

import { NotificationService } from './NotificationService'

export type AssistantNotificationTarget = { agentId: string; sessionId: string }
export const ASSISTANT_NOTIFICATION_OPEN = 'zen-ai:open-assistant-notification'

export function readAssistantNotificationTarget(value: unknown): AssistantNotificationTarget | undefined {
  const target = value as Partial<AssistantNotificationTarget> | undefined
  if (
    target?.agentId !== DEFAULT_OPENCODE_AGENT_ID ||
    typeof target.sessionId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(target.sessionId)
  )
    return
  return { agentId: target.agentId, sessionId: target.sessionId }
}

export function openAssistantNotification(meta: unknown): boolean {
  const target = readAssistantNotificationTarget((meta as { assistantTarget?: unknown } | undefined)?.assistantTarget)
  if (!target) return false
  window.dispatchEvent(new CustomEvent(ASSISTANT_NOTIFICATION_OPEN, { detail: target }))
  return true
}

export function isViewingAssistantConversation(target: AssistantNotificationTarget): boolean {
  const chat = store.getState().runtime?.chat
  if (!chat) return false
  return (
    document.hasFocus() &&
    window.location.hash.split('?')[0] === '#/new-assistant' &&
    chat.activeAgentId === target.agentId &&
    chat.activeSessionIdMap[target.agentId] === target.sessionId
  )
}

const sent = new Set<string>()
export async function notifyAssistantTask(
  target: AssistantNotificationTarget,
  operationId: string,
  kind: 'success' | 'error' | 'permission' | 'handoff'
): Promise<void> {
  if (!readAssistantNotificationTarget(target)) return
  if (!store.getState().settings.notification?.assistant) return
  if (isViewingAssistantConversation(target)) return
  const key = `${target.sessionId}:${operationId}:${kind}`
  if (sent.has(key)) return
  sent.add(key)
  if (sent.size > 512) sent.delete(sent.values().next().value!)
  // No titles, inputs, paths, URLs or model output in lock-screen notifications.
  await NotificationService.getInstance().send({
    id: key,
    type: kind === 'success' ? 'success' : kind === 'error' ? 'error' : 'action',
    title: i18n.t('assistantPeripheral.notificationTitle'),
    message: i18n.t(
      {
        success: 'assistantPeripheral.notify_success',
        error: 'assistantPeripheral.notify_error',
        permission: 'assistantPeripheral.notify_permission',
        handoff: 'assistantPeripheral.notify_handoff'
      }[kind]
    ),
    timestamp: Date.now(),
    source: 'assistant',
    silent: false,
    meta: { assistantTarget: target }
  })
}

export function permissionNotificationTarget(toolCallId?: string): AssistantNotificationTarget | undefined {
  const sessionId = toolCallId?.split(':')[0]
  if (!sessionId) return
  const messages = Object.values(store.getState().messages.entities) as Array<Message | undefined>
  if (
    !messages.some(
      (message) =>
        message?.assistantId === DEFAULT_OPENCODE_AGENT_ID && message.topicId === `agent-session:${sessionId}`
    )
  )
    return
  return readAssistantNotificationTarget({ agentId: DEFAULT_OPENCODE_AGENT_ID, sessionId })
}
