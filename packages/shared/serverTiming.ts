/** Safe server timing contract. Missing, unsupported and unfinished are never zero. */
const phaseNames = ['body_ready', 'routing_ready', 'validated', 'tokens_ready', 'admission_ready'] as const
const milestoneNames = ['first_event', 'first_content', 'first_text', 'first_forward'] as const
const httpNumbers = [
  'attempt_offset_ms',
  'request_bytes',
  'dns_ms',
  'connect_ms',
  'connect_attempts',
  'tls_ms',
  'connection_requested_ms',
  'connection_ready_ms',
  'request_sent_ms',
  'first_byte_ms',
  'response_headers_ms',
  'http_status',
  'total_ms',
  'body_done_ms',
  'response_body_ms',
  'wait_after_send_ms',
  'response_bytes'
] as const
const httpBooleans = [
  'dns_error',
  'connect_error',
  'tls_error',
  'connection_reused',
  'request_write_error',
  'request_error',
  'channel_proxy_configured',
  'body_complete',
  'body_error'
] as const
type ServerHTTP = Partial<
  Record<(typeof httpNumbers)[number], number> & Record<(typeof httpBooleans)[number], boolean>
> & { started_at?: string; upstream_request_id?: string }
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const date = (value: unknown) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined)
const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 256) : undefined)
const elapsed = (a: unknown, b: unknown) => {
  const start = date(a)
  const end = date(b)
  return start && end ? number(Date.parse(end) - Date.parse(start)) : null
}
const numericFields = <Name extends string>(value: unknown, names: readonly Name[]): Partial<Record<Name, number>> => {
  const source = object(value)
  return Object.fromEntries(
    names.flatMap((name) => (number(source[name]) === null ? [] : [[name, source[name] as number]]))
  ) as Partial<Record<Name, number>>
}

export const serverPhases = (value: unknown) => numericFields(value, phaseNames)
export function serverAttemptTiming(value: unknown) {
  const source = object(value)
  const startedAt = date(source.startedAt)
  if (!startedAt) return undefined
  return {
    startedAt,
    milestones: numericFields(source.milestones, milestoneNames),
    droppedHttp: number(source.droppedHttp) ?? 0,
    http: Array.isArray(source.http)
      ? source.http.slice(0, 8).map((entry): ServerHTTP => {
          const fields = object(entry)
          return {
            ...numericFields(fields, httpNumbers),
            ...Object.fromEntries(
              httpBooleans.flatMap((name) => (typeof fields[name] === 'boolean' ? [[name, fields[name]]] : []))
            ),
            ...(date(fields.started_at) ? { started_at: date(fields.started_at) } : {}),
            ...(typeof fields.upstream_request_id === 'string' &&
            /^[A-Za-z0-9_.-]{1,128}$/.test(fields.upstream_request_id)
              ? { upstream_request_id: fields.upstream_request_id }
              : {})
          }
        })
      : []
  }
}

export function buildServerPerformance(
  entries: Array<Record<string, unknown>>,
  clientRequests: Array<{ requestId?: string; durationMs: number | null }>
) {
  return entries.slice(0, 128).map((entry) => {
    const requestId = text(entry.requestId)
    const client = clientRequests.find((request) => requestId && request.requestId === requestId)
    const totalMs = elapsed(entry.startedAt, entry.finishedAt)
    const attempts = Array.isArray(entry.attempts)
      ? entry.attempts.slice(0, 64).map((value) => {
          const attempt = object(value)
          const timing = serverAttemptTiming(attempt.timing)
          const milestones = timing?.milestones ?? {}
          const difference = (a: keyof typeof milestones, b: keyof typeof milestones) =>
            number(milestones[a]) !== null && number(milestones[b]) !== null
              ? number(milestones[b]! - milestones[a]!)
              : null
          return {
            index: number(attempt.index),
            channelId: number(attempt.channelId),
            outcome: text(attempt.outcome),
            durationMs: attempt.outcome === 'pending' ? null : number(attempt.durationMs),
            gatewayBeforeAttemptMs: elapsed(entry.startedAt, attempt.startedAt),
            timing: timing ?? null,
            firstContentAfterEventMs: difference('first_event', 'first_content'),
            firstForwardAfterContentMs: difference('first_content', 'first_forward'),
            missing: [
              ...(!timing ? ['server-attempt-timing-not-recorded'] : []),
              ...(!timing?.http.length ? ['http-trace-unavailable-or-still-running'] : []),
              ...(!('first_content' in milestones) ? ['first-effective-content-unrecorded-or-not-applicable'] : []),
              ...((timing?.droppedHttp ?? 0) > 0 ? ['bounded-http-traces-truncated'] : [])
            ]
          }
        })
      : []
    return {
      requestId,
      model: text(entry.model),
      outcome: text(entry.outcome),
      totalMs,
      firstWriteMs: elapsed(entry.startedAt, entry.firstWriteAt),
      phases: serverPhases(entry.phases),
      clientRequestMs: client?.durationMs ?? null,
      // Compare elapsed durations only; never subtract client/server wall clocks.
      outsideGatewayMs: client?.durationMs != null && totalMs !== null ? number(client.durationMs - totalMs) : null,
      attempts,
      missing: [
        ...(!client ? ['client-request-timeline-not-correlated'] : []),
        ...(!Object.keys(serverPhases(entry.phases)).length ? ['server-preparation-phases-unrecorded'] : []),
        ...(number(entry.droppedAttempts) ? ['bounded-channel-attempts-truncated'] : [])
      ]
    }
  })
}
