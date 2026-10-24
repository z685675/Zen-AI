import type { DiagnosticEvent } from './diagnostics'

export type TurnInterval = {
  kind: 'request' | 'tool' | 'preparation' | 'context' | 'runtime-stage'
  id: string
  label: string
  startedAt: string
  finishedAt?: string
  durationMs: number | null
  outcome?: string
  headersMs?: number | null
  firstBytesMs?: number | null
  requestId?: string
  httpStatus?: number
}

const time = (value?: string) => (value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined)
const duration = (start?: string, end?: string): number | null => {
  const a = time(start)
  const b = time(end)
  return a === undefined || b === undefined || b < a ? null : b - a
}
const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 256) : undefined)

/** Pure observation: never replay, probe, infer a server root cause, or add overlapping spans. */
export function buildTurnPerformance(input: {
  events: DiagnosticEvent[]
  startedAt?: string
  finishedAt?: string
  outcome?: string
  elapsedMs?: number
  firstTokenMs?: number
  droppedEvents?: number
}) {
  const events = input.events.filter((event) => time(event.at) !== undefined).sort((a, b) => time(a.at)! - time(b.at)!)
  const intervals: TurnInterval[] = []
  const requests = new Map<string, TurnInterval>()
  const tools = new Map<string, TurnInterval>()
  const phases = new Map<string, TurnInterval>()
  let nativeStage: TurnInterval | undefined
  const close = (span: TurnInterval | undefined, event: DiagnosticEvent) => {
    if (!span || span.finishedAt) return
    span.finishedAt = event.at
    span.durationMs = duration(span.startedAt, event.at)
    span.outcome = event.event
  }
  for (const event of events) {
    const details = event.details ?? {}
    if (event.stage === 'transport') {
      const key = text(details.transportRequestId) ?? text(details.traceId)
      let span = key ? requests.get(key) : undefined
      // Legacy native events lack an attempt ID. Match only if unambiguous.
      if (!key && event.event !== 'request-started') {
        const pending = [...requests.values()].filter((item) => !item.finishedAt)
        if (pending.length === 1) span = pending[0]
      }
      if (event.event === 'request-started') {
        span = {
          kind: 'request',
          id: key ?? `request-${intervals.length + 1}`,
          label: text(details.model) ?? 'HTTP',
          startedAt: event.at,
          durationMs: null
        }
        requests.set(span.id, span)
        intervals.push(span)
      } else if (span) {
        if (event.event === 'headers-received') {
          span.headersMs = duration(span.startedAt, event.at)
          span.requestId = text(details.requestId)
          span.httpStatus = typeof details.status === 'number' ? details.status : undefined
          // Even an HTTP error may spend time reading its response body. Only
          // a terminal event proves when this attempt actually finished.
        }
        if (event.event === 'first-bytes') span.firstBytesMs = duration(span.startedAt, event.at)
        if (['body-complete', 'failed', 'cancelled'].includes(event.event)) close(span, event)
      }
    }
    if (event.stage === 'tool') {
      const id = text(details.toolCallId)
      if (id && event.event === 'tool-call' && !tools.has(id)) {
        const span: TurnInterval = {
          kind: 'tool',
          id,
          label: text(details.toolName) ?? 'tool',
          startedAt: event.at,
          durationMs: null
        }
        tools.set(id, span)
        intervals.push(span)
      }
      if (id && ['tool-result', 'tool-error', 'tool-cancelled'].includes(event.event)) close(tools.get(id), event)
    }
    if (
      ['preparation', 'context'].includes(event.stage) &&
      ['started', 'ready', 'messages-ready', 'failed', 'cancelled'].includes(event.event)
    ) {
      const key = `${event.stage}:${text(details.phase) ?? 'messages'}`
      if (event.event === 'started') {
        const span: TurnInterval = {
          kind: event.stage as 'preparation' | 'context',
          id: key,
          label: text(details.phase) ?? event.stage,
          startedAt: event.at,
          durationMs: null
        }
        phases.set(key, span)
        intervals.push(span)
      } else close(phases.get(key), event)
    }
    if (event.stage === 'runtime' && event.event === 'task-stage' && typeof details.stage === 'string') {
      close(nativeStage, event)
      nativeStage = {
        kind: 'runtime-stage',
        id: `stage-${intervals.length}`,
        label: details.stage,
        startedAt: event.at,
        durationMs: null
      }
      intervals.push(nativeStage)
    }
    if (event.stage === 'runtime' && ['complete', 'failed', 'cancelled'].includes(event.event))
      close(nativeStage, event)
  }
  const first = (name: string) => events.find((event) => event.event === name)?.at
  const last = (stage: string, name: string) =>
    events.findLast((event) => event.stage === stage && event.event === name)?.at
  const startedAt = input.startedAt
  const finishedAt = input.finishedAt
  const number = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  const waits = intervals.filter(
    (span) =>
      (span.kind === 'runtime-stage' && span.label === 'waiting_permission') ||
      (span.kind === 'tool' && /wait_for_user|ask_user|question/i.test(span.label))
  )
  const completed = intervals.filter((span) => span.durationMs !== null)
  return {
    schemaVersion: 1,
    outcome: input.outcome ?? 'unrecorded',
    startedAt: startedAt ?? null,
    finishedAt: finishedAt ?? null,
    totalMs: number(input.elapsedMs) ?? duration(startedAt, finishedAt),
    firstContentMs: number(input.firstTokenMs) ?? duration(startedAt, first('first-content')),
    firstTextMs: duration(startedAt, first('first-text')),
    firstBytesMs: duration(startedAt, first('first-bytes')),
    responseFinishedAt: last('response', 'processed') ?? last('response', 'model-complete') ?? null,
    uiStateAppliedAt: last('ui', 'state-applied') ?? null,
    renderCommittedAt: last('ui', 'render-committed') ?? null,
    // Not all DOM paint work is measurable from a React commit.
    renderCommitDelayMs: duration(finishedAt, last('ui', 'render-committed')),
    observedRequests: intervals.filter((span) => span.kind === 'request').length,
    toolCalls: tools.size,
    retryEvents: events.filter((event) =>
      ['native-retry', 'key-fallback', 'model-fallback', 'fallback', 'stream-recovery'].includes(event.event)
    ).length,
    droppedEvents: input.droppedEvents ?? 0,
    intervals,
    userWaitIntervals: waits,
    slowestObserved: [...completed].sort((a, b) => b.durationMs! - a.durationMs!).slice(0, 8),
    coverage: {
      source: 'observed-events-only',
      durationsAreAdditive: false,
      activeWorkMs: null,
      missing: [
        ...(!startedAt ? ['request-start-time'] : []),
        ...(!finishedAt ? ['request-end-time-or-still-running'] : []),
        ...(!first('first-text') ? ['first-answer-text'] : []),
        ...(intervals.some((span) => !span.finishedAt) ? ['unfinished-or-unpaired-intervals'] : []),
        ...((input.droppedEvents ?? 0) > 0 ? ['bounded-events-truncated'] : []),
        'attachment-upload-before-response-preparation',
        'server-internal-breakdown-requires-correlated-api-evidence',
        'user-wait-may-overlap-tool-execution-do-not-subtract-or-sum'
      ]
    }
  }
}
