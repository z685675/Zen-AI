import type { AgentPersistedMessage, GetAgentSessionResponse } from '@types'

import { type DshNativeEvent, readDshSessionHistory, replaceDshSessionHistory } from '../../../dshPreview/runtime'
import { acquireSessionActivity } from '../sessionActivity'

/** DSH is an append-only event log. Only complete prefixes can be safely copied;
 * removing individual tool/assistant records would break native references. */
export function planDshHistory(
  events: DshNativeEvent[],
  display: AgentPersistedMessage[],
  messageId: string,
  action: 'retry' | 'delete' | 'fork'
) {
  const selectedIndex = display.findIndex((item) => item.message.id === messageId)
  if (selectedIndex < 0) throw new Error('Message not found')
  const selected = display[selectedIndex].message
  const userId = selected.role === 'user' ? selected.id : selected.askId
  const userIndex = display.findIndex((item) => item.message.id === userId && item.message.role === 'user')
  if (userIndex < 0) throw new Error('Original user message not found')
  const user = display[userIndex].message
  const exactId = (user.providerMetadata?.dsh as { user_message_id?: string } | undefined)?.user_message_id
  // Refuse to guess with ordinal positions: an in-flight steer or failed local
  // preflight can introduce display turns that have never entered native history.
  const eventIndex = events.findIndex((event) => event.type === 'user/message' && event.data.id === exactId)
  if (!exactId || eventIndex < 0) throw new Error('Native and display history do not match')
  let start = eventIndex
  while (start >= 0 && events[start].type !== 'turn/start') start--
  if (start < 0) throw new Error('Native turn boundary not found')
  let end = eventIndex
  while (end < events.length && events[end].type !== 'turn/end') end++
  if (end === events.length) throw new Error('Native turn is still open')
  const cut = action === 'fork' ? end + 1 : start
  // Multiple user messages may belong to one turn (native steering). Include or
  // remove the complete turn in both stores, rather than leaving phantom input.
  const turnUsers = new Set(
    events
      .slice(start, end + 1)
      .filter((event) => event.type === 'user/message')
      .map((event) => event.data.id)
  )
  const firstDisplay = display.findIndex(
    (item) =>
      item.message.role === 'user' &&
      turnUsers.has((item.message.providerMetadata?.dsh as { user_message_id?: string } | undefined)?.user_message_id)
  )
  if (firstDisplay < 0) throw new Error('Native turn has no display input')
  const kept =
    action === 'fork'
      ? display.filter(
          (item, index) =>
            index < firstDisplay ||
            turnUsers.has(
              (item.message.providerMetadata?.dsh as { user_message_id?: string } | undefined)?.user_message_id
            )
        )
      : display.slice(0, action === 'retry' ? firstDisplay + 1 : firstDisplay)
  return { events: events.slice(0, cut), items: structuredClone(kept) }
}

export async function editDshNativeHistory(
  session: GetAgentSessionResponse,
  display: AgentPersistedMessage[],
  messageId: string,
  action: 'retry' | 'delete' | 'fork',
  commit: (items: AgentPersistedMessage[], nativeId: string) => Promise<void>
) {
  const release = acquireSessionActivity(session.id, 'continuation')
  try {
    const original = await readDshSessionHistory(session.id)
    const plan = planDshHistory(original.events, display, messageId, action)
    const changed = await replaceDshSessionHistory(session.id, plan.events)
    for (const item of plan.items) {
      item.message.agentSessionId = changed.sessionId
      item.message.providerMetadata = {
        ...item.message.providerMetadata,
        dsh: { ...item.message.providerMetadata?.dsh, session_id: changed.sessionId }
      }
    }
    try {
      await commit(plan.items, changed.sessionId)
    } catch (error) {
      await replaceDshSessionHistory(session.id, original.events)
      throw error
    }
  } finally {
    release()
  }
}
