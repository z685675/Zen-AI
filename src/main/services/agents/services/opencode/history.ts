import type { AgentPersistedMessage, GetAgentSessionResponse } from '@types'

import { prepareOpenCodeRuntime } from './prepare'
import type { OpenCodeProcess } from './process'

export type HistoryAction = 'retry' | 'delete' | 'fork'
type NativeEntry = {
  info: { id: string; role: string; parentID?: string; summary?: boolean }
  parts: Array<{ type: string; synthetic?: boolean; [key: string]: unknown }>
}

/** Exact IDs for new turns; guarded ordinal migration for pre-ID preview history. */
export function planNativeHistory(
  entries: NativeEntry[],
  display: AgentPersistedMessage[],
  messageId: string,
  action: HistoryAction
) {
  if (display.find((item) => item.message.id === messageId)?.message.providerMetadata?.legacyContinuation)
    throw new Error('Imported historical records are read-only; continue with a new message')
  const index = display.findIndex((item) => item.message.id === messageId)
  if (index < 0) throw new Error('Message not found')
  const selected = display[index].message
  const userId = selected.role === 'user' ? selected.id : selected.askId
  const users = display.filter(
    (item) => item.message.role === 'user' && !item.message.providerMetadata?.legacyContinuation
  )
  const userIndex = users.findIndex((item) => item.message.id === userId)
  if (userIndex < 0) throw new Error('Original user message not found')
  const nativeUsers = entries.filter(
    (item) =>
      item.info.role === 'user' &&
      item.parts.some((part) => part.type === 'text' && !part.synthetic) &&
      !item.parts.some((part) => part.type === 'compaction')
  )
  const nativeMetadata = users[userIndex].message.providerMetadata?.opencode
  const exactId = nativeMetadata?.user_message_id
  const exact = typeof exactId === 'string' ? entries.findIndex((item) => item.info.id === exactId) : -1
  if (exact < 0 && userIndex === users.length - 1 && nativeUsers.length === users.length - 1) {
    // A local preflight/connection failure may not have admitted this turn.
    const userPosition = display.findIndex((item) => item.message.id === userId)
    return {
      cutoff: entries.length,
      remove: [],
      keepDisplay:
        action === 'retry'
          ? display.slice(0, userPosition + 1)
          : action === 'delete'
            ? display.filter(
                (item) => item.message.id !== selected.id && (selected.role !== 'user' || item.message.askId !== userId)
              )
            : display.slice(0, index + 1)
    }
  }
  if (exact < 0 && nativeUsers.length !== users.length)
    throw new Error('Native and display history do not match; no history was changed')
  const nativeIndex = exact >= 0 ? exact : entries.indexOf(nativeUsers[userIndex])
  const nativeUser = entries[nativeIndex]
  if (!nativeUser || nativeUser.info.role !== 'user') throw new Error('Native user message not found')
  const nextUser = entries.findIndex((item, i) => i > nativeIndex && nativeUsers.includes(item))
  const end = nextUser < 0 ? entries.length : nextUser
  const cutoff = action === 'retry' ? nativeIndex : action === 'fork' ? end : entries.length
  const remove =
    action === 'delete'
      ? entries.flatMap((item, i) => {
          const inTurn = i >= nativeIndex && i < end && (selected.role === 'user' || item.info.role === 'assistant')
          // Later summaries may remember deleted text; remove summaries and their
          // compaction markers, retaining the original ordinary messages.
          const staleSummary =
            i >= nativeIndex && (item.info.summary || item.parts.some((part) => part.type === 'compaction'))
          return inTurn || staleSummary ? [item.info.id] : []
        })
      : []
  const keepDisplay =
    action === 'retry'
      ? display.slice(0, display.findIndex((item) => item.message.id === userId) + 1)
      : action === 'fork'
        ? display.slice(0, index + 1)
        : display.filter((item) =>
            selected.role === 'user'
              ? item.message.id !== userId && item.message.askId !== userId
              : item.message.id !== selected.id
          )
  return { cutoff, remove, keepDisplay }
}

/** Fork first: errors never partially destroy the currently bound history. */
export async function editNativeHistory(
  session: GetAgentSessionResponse,
  display: AgentPersistedMessage[],
  messageId: string,
  action: HistoryAction,
  commit: (items: AgentPersistedMessage[], nativeId: string) => Promise<void>
) {
  let runtime: OpenCodeProcess | undefined
  const signal = AbortSignal.timeout(90_000)
  try {
    runtime = await prepareOpenCodeRuntime(session, signal)
    const previous = await runtime.session(signal)
    const entries = await runtime.client.request<NativeEntry[]>(
      `/session/${previous}/message`,
      'GET',
      undefined,
      signal
    )
    const plan = planNativeHistory(entries, display, messageId, action)
    const fork = await runtime.client.request<{ id: string }>(
      `/session/${previous}/fork`,
      'POST',
      {
        ...(plan.cutoff < entries.length ? { messageID: entries[plan.cutoff].info.id } : {})
      },
      signal
    )
    const cloned = await runtime.client.request<NativeEntry[]>(`/session/${fork.id}/message`, 'GET', undefined, signal)
    if (cloned.length !== plan.cutoff) throw new Error('Native history copy is incomplete')
    const ids = new Map(entries.slice(0, plan.cutoff).map((entry, i) => [entry.info.id, cloned[i].info.id]))
    for (const id of plan.remove) {
      const newId = ids.get(id)
      if (newId) await runtime.client.request(`/session/${fork.id}/message/${newId}`, 'DELETE', undefined, signal)
    }
    const items = structuredClone(plan.keepDisplay)
    for (const item of items) {
      const metadata = item.message.providerMetadata?.opencode
      const oldId = metadata?.user_message_id
      if (typeof oldId === 'string' && ids.has(oldId)) {
        item.message.providerMetadata = {
          ...item.message.providerMetadata,
          opencode: { ...metadata, user_message_id: ids.get(oldId)!, session_id: fork.id }
        }
      }
      item.message.agentSessionId = fork.id
    }
    await runtime.bindSession(fork.id)
    try {
      await commit(items, fork.id)
    } catch (error) {
      await runtime.bindSession(previous)
      throw error
    }
    return fork.id
  } finally {
    runtime?.release()
  }
}
