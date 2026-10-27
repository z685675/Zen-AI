import type { Message, MessageResponseTiming } from '@renderer/types/newMessage'
import dayjs from 'dayjs'

/** One timer per response, shared by all text/reasoning/tool steps. */
export function createMessageResponseTimer() {
  const startedAt = Date.now()
  const startedClock = performance.now()
  let firstTokenMs: number | undefined
  let finished: MessageResponseTiming | undefined
  const markFirstActivity = () => {
    if (finished || firstTokenMs !== undefined) return
    firstTokenMs = Math.max(0, performance.now() - startedClock)
  }

  return {
    // Agent responses can begin with a tool instead of visible text. Keep the
    // stored field compatible, but do not invent a text token to mark activity.
    markFirstActivity,
    markFirstToken(text: string) {
      if (text.trim()) markFirstActivity()
    },
    finish(outcome: MessageResponseTiming['outcome']): MessageResponseTiming {
      finished ??= {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        firstTokenMs,
        elapsedMs: Math.max(0, performance.now() - startedClock),
        outcome
      }
      return finished
    }
  }
}

export function getMessageDisplayTimestamp(message: Message): string {
  if (message.role === 'user') return message.createdAt
  const finishedAt = message.role === 'assistant' ? message.providerMetadata?.responseTiming?.finishedAt : undefined
  if (finishedAt && Number.isFinite(Date.parse(finishedAt))) return finishedAt
  return message.updatedAt ?? message.createdAt
}

export function formatMessageTimestamp(message: Message): string {
  return dayjs(getMessageDisplayTimestamp(message)).format('MM/DD HH:mm:ss')
}

export function getMessageTimingStats(message: Message) {
  const timing = message.providerMetadata?.responseTiming
  const valid = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  if (timing) {
    return {
      firstTokenMs: valid(timing.firstTokenMs),
      elapsedMs: valid(timing.elapsedMs),
      outcome: timing.outcome
    }
  }
  // Legacy streamed metrics measured completion from the first token, not
  // from submission. Do not invent a completion timestamp for those messages.
  const firstTokenMs = valid(message.metrics?.time_first_token_millsec)
  const completionMs = valid(message.metrics?.time_completion_millsec)
  return {
    firstTokenMs,
    elapsedMs: completionMs === undefined ? undefined : completionMs + (firstTokenMs ?? 0),
    outcome: undefined
  }
}

export function formatMessageDuration(milliseconds?: number): string {
  return typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds >= 0
    ? `${(milliseconds / 1000).toFixed(2)}s`
    : '—'
}
