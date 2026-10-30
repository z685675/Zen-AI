import i18n from '@renderer/i18n'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { readOpenCodeTurnDiagnostics } from '@shared/agents/opencodeDiagnostics'
import type { DiagnosticEvent, DiagnosticEvidence } from '@shared/diagnostics'
import { serverAttemptTiming, serverPhases } from '@shared/serverTiming'
import { buildTurnPerformance } from '@shared/turnPerformance'

// Strict allow-list for exports without conversation content. In particular,
// never copy settings, tool arguments/results, stderr, prompts or error text.
const fields = new Set([
  'runtime',
  'stage',
  'phase',
  'status',
  'code',
  'method',
  'url',
  'traceId',
  'requestId',
  'transportRequestId',
  'model',
  'modelId',
  'providerId',
  'toolName',
  'toolCallId',
  'elapsedMs',
  'durationMs',
  'attempt',
  'nextPosition',
  'startup',
  'unexpected',
  'active',
  'timedOut',
  'timeoutMs',
  'receivedResponse',
  'gateway',
  'action',
  'usedLocalCheckpoint',
  'contextWindowTokens',
  'safeInputTokens',
  'inputTokensBefore',
  'inputTokensAfter',
  'outputCharacters',
  'uiMessageCount',
  'convertedMessageCount',
  'estimatedTokens',
  'type',
  'bytes',
  'chunks',
  'bodyBytes',
  'messageCount',
  'toolCount',
  'permission',
  'linkedTool',
  'behavior',
  'zenFailureStage',
  'measurement',
  'observedActiveAt',
  'responseFinishedAt'
])
export function metadataEvent(event: DiagnosticEvent): DiagnosticEvent {
  return {
    at: event.at,
    stage: event.stage,
    event: event.event,
    details: {
      ...scalarFields(event.details, [...fields]),
      // Retain only the error class for attribution, never its message or stack.
      ...(event.details?.error && typeof event.details.error === 'object'
        ? { error: metadataError(event.details.error) }
        : {})
    }
  }
}
export function metadataError(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || depth >= 4) return undefined
  return {
    ...scalarFields(value, ['name', 'status', 'statusCode', 'code', 'zenFailureStage']),
    ...('cause' in value ? { cause: metadataError(value.cause, depth + 1) } : {})
  }
}
function scalarFields(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object') return undefined
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, entry]) => keys.includes(key) && ['string', 'number', 'boolean'].includes(typeof entry)
    )
  )
}

/** The API diagnostic contract is metadata-only; still allow-list it against future additions. */
export function metadataBackend(entry: Record<string, unknown>) {
  return {
    phases: serverPhases(entry.phases),
    ...scalarFields(entry, [
      'requestId',
      'traceId',
      'operationId',
      'version',
      'startedAt',
      'finishedAt',
      'path',
      'model',
      'inputTokens',
      'outputTokens',
      'status',
      'outcome',
      'failureStage',
      'droppedAttempts',
      'firstWriteAt',
      'writtenBytes',
      'writeFailed',
      'clientDisconnected',
      'persistence'
    ]),
    ...(Array.isArray(entry.attempts)
      ? {
          attempts: entry.attempts.slice(0, 64).map((attempt) => ({
            ...scalarFields(attempt, [
              'index',
              'channelId',
              'channelType',
              'group',
              'upstreamModel',
              'startedAt',
              'durationMs',
              'outcome',
              'status',
              'errorCode',
              'streamEndReason'
            ]),
            timing: serverAttemptTiming(attempt && typeof attempt === 'object' ? attempt.timing : undefined)
          }))
        }
      : {})
  }
}

export function metadataBackendCollection(details: unknown) {
  const responses = Array.isArray(details)
    ? details
    : details && typeof details === 'object' && 'responses' in details
      ? details.responses
      : []
  return Array.isArray(responses)
    ? responses
        .slice(0, 24)
        .map((entry) =>
          scalarFields(entry, ['requestId', 'status', 'source', 'available', 'omittedRequests', 'persistentStatus'])
        )
    : []
}
export function metadataEvidence(evidence: DiagnosticEvidence | undefined) {
  if (!evidence) return undefined
  return {
    operationId: evidence.operationId,
    startedAt: evidence.startedAt,
    updatedAt: evidence.updatedAt,
    events: evidence.events.map(metadataEvent),
    droppedEvents: evidence.droppedEvents
  }
}
export function metadataMessage(message?: Message) {
  if (!message) return undefined
  return {
    id: message.id,
    askId: message.askId,
    topicId: message.topicId,
    role: message.role,
    status: message.status,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    model: message.model ? { id: message.model.id, provider: message.model.provider } : undefined,
    usage: message.usage
      ? {
          ...scalarFields(message.usage, [
            'prompt_tokens',
            'completion_tokens',
            'total_tokens',
            'thoughts_tokens',
            'cost',
            'cache_read_tokens',
            'cache_write_tokens',
            'no_cache_tokens',
            'cached_tokens'
          ]),
          prompt_tokens_details: scalarFields(message.usage.prompt_tokens_details, ['cached_tokens'])
        }
      : undefined,
    metrics: scalarFields(message.metrics, [
      'completion_tokens',
      'time_completion_millsec',
      'time_first_token_millsec',
      'time_thinking_millsec'
    ]),
    opencodeDiagnostics: readOpenCodeTurnDiagnostics(message.providerMetadata?.opencodeDiagnostics),
    responseTiming: scalarFields(message.providerMetadata?.responseTiming, [
      'startedAt',
      'finishedAt',
      'firstTokenMs',
      'elapsedMs',
      'outcome'
    ])
  }
}
export function metadataBlock(block?: MessageBlock) {
  if (!block) return undefined
  return {
    id: block.id,
    type: block.type,
    status: block.status,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
    ...('file' in block && block.file
      ? { attachment: { size: block.file.size, ext: block.file.ext, type: block.file.type } }
      : {}),
    ...('toolName' in block ? { toolName: block.toolName, toolId: block.toolId } : {})
  }
}

export function createTurnReport(
  message: Message,
  events: DiagnosticEvent[],
  startedAt?: string,
  droppedEvents = 0,
  backendEvidence: Array<Record<string, unknown>> = []
) {
  const timing = message.providerMetadata?.responseTiming
  const useResponseTimer = !startedAt || startedAt === timing?.startedAt
  const performance = buildTurnPerformance({
    events,
    startedAt: startedAt ?? timing?.startedAt,
    finishedAt: timing?.finishedAt,
    outcome: timing?.outcome ?? message.status,
    elapsedMs: useResponseTimer ? timing?.elapsedMs : undefined,
    firstTokenMs: useResponseTimer ? timing?.firstTokenMs : undefined,
    droppedEvents,
    persistedDiagnostics: message.providerMetadata?.opencodeDiagnostics,
    backendEvidence
  })
  const t = i18n.t
  const unavailable = t('turnDiagnostics.notRecorded')
  const ms = (value: number | null | undefined) => (value == null ? unavailable : `${(value / 1000).toFixed(2)}s`)
  const count = (value: number | undefined) => (value === undefined ? unavailable : String(value))
  const usage = message.usage
  const cache = usage?.cache_read_tokens ?? usage?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens
  const kinds: Record<string, string> = {
    request: t('turnDiagnostics.intervalKinds.request'),
    tool: t('turnDiagnostics.intervalKinds.tool'),
    preparation: t('turnDiagnostics.intervalKinds.preparation'),
    context: t('turnDiagnostics.intervalKinds.context'),
    'runtime-stage': t('turnDiagnostics.intervalKinds.runtime')
  }
  const outcomes: Record<string, string> = {
    completed: t('turnDiagnostics.outcomes.completed'),
    success: t('turnDiagnostics.outcomes.completed'),
    failed: t('turnDiagnostics.outcomes.failed'),
    error: t('turnDiagnostics.outcomes.failed'),
    cancelled: t('turnDiagnostics.outcomes.cancelled'),
    paused: t('turnDiagnostics.outcomes.cancelled'),
    processing: t('turnDiagnostics.outcomes.processing'),
    pending: t('turnDiagnostics.outcomes.pending')
  }
  const summary =
    t('turnDiagnostics.reportTemplate', {
      outcome: outcomes[performance.outcome] ?? performance.outcome,
      model: message.model?.id ?? unavailable,
      provider: message.model?.provider ?? unavailable,
      input: count(usage?.prompt_tokens),
      output: count(usage?.completion_tokens),
      cache: count(cache),
      start: performance.startedAt ?? unavailable,
      end: performance.finishedAt ?? unavailable,
      total: ms(performance.totalMs),
      firstContent: ms(performance.firstContentMs),
      firstText: ms(performance.firstTextMs),
      firstBytes: ms(performance.firstBytesMs),
      requests: performance.observedRequests ?? unavailable,
      tools: performance.toolCalls ?? unavailable,
      retries: performance.retryEvents ?? unavailable,
      render:
        performance.renderCommitDelayMs == null
          ? t('turnDiagnostics.renderNotRecorded')
          : ms(performance.renderCommitDelayMs),
      slowest:
        performance.slowestObserved
          .map((span) => `- ${kinds[span.kind]} / ${span.label}: ${ms(span.durationMs)}`)
          .join('\n') || unavailable,
      timeline:
        performance.intervals
          .map((span) => {
            const request =
              span.kind === 'request'
                ? t('turnDiagnostics.requestTiming', {
                    headers: ms(span.headersMs),
                    bytes: ms(span.firstBytesMs),
                    status: span.httpStatus ?? unavailable,
                    requestId: span.requestId ?? unavailable
                  })
                : ''
            return `- ${span.startedAt} → ${span.finishedAt ?? unavailable} | ${kinds[span.kind]} / ${span.label} | ${ms(span.durationMs)}${request}`
          })
          .join('\n') || unavailable,
      waits:
        performance.userWaitIntervals.map((span) => `- ${span.label}: ${ms(span.durationMs)}`).join('\n') ||
        unavailable,
      dropped: droppedEvents,
      missing: performance.coverage.missing.join(', ')
    }) +
    (performance.aggregate
      ? '\n\n' +
        t('turnDiagnostics.aggregate', {
          requests: ms(performance.aggregate.upstreamRequestMs),
          headers: ms(performance.aggregate.upstreamHeaderWaitMs),
          tools: ms(performance.aggregate.completedToolObservedMs)
        })
      : '')
  const phaseLabels: Record<string, string> = {
    body_ready: t('turnDiagnostics.serverTiming.phases.body_ready'),
    routing_ready: t('turnDiagnostics.serverTiming.phases.routing_ready'),
    validated: t('turnDiagnostics.serverTiming.phases.validated'),
    tokens_ready: t('turnDiagnostics.serverTiming.phases.tokens_ready'),
    admission_ready: t('turnDiagnostics.serverTiming.phases.admission_ready')
  }
  const serverSummary =
    t('turnDiagnostics.serverTiming.intro') +
    '\n' +
    (performance.serverRequests
      .map((request) => {
        const phases =
          Object.entries(request.phases)
            .map(([name, value]) => `${phaseLabels[name]} ${ms(value)}`)
            .join(' | ') || unavailable
        return (
          t('turnDiagnostics.serverTiming.request', {
            requestId: request.requestId ?? unavailable,
            total: ms(request.totalMs),
            outside: ms(request.outsideGatewayMs),
            phases
          }) +
          '\n' +
          request.attempts
            .map((attempt) => {
              const marks = attempt.timing?.milestones ?? {}
              const http =
                attempt.timing?.http
                  .map((entry, index) =>
                    t('turnDiagnostics.serverTiming.http', {
                      index: index + 1,
                      prepare: ms(entry.attempt_offset_ms),
                      dns: ms(entry.dns_ms),
                      connect: ms(entry.connect_ms),
                      tls: ms(entry.tls_ms),
                      ready: ms(entry.connection_ready_ms),
                      sent: ms(entry.request_sent_ms),
                      firstByte: ms(entry.first_byte_ms),
                      wait: ms(entry.wait_after_send_ms),
                      body: ms(entry.response_body_ms),
                      reused:
                        typeof entry.connection_reused === 'boolean'
                          ? t(
                              entry.connection_reused
                                ? 'turnDiagnostics.serverTiming.yes'
                                : 'turnDiagnostics.serverTiming.no'
                            )
                          : unavailable
                    })
                  )
                  .join('\n') || unavailable
              return t('turnDiagnostics.serverTiming.attempt', {
                index: attempt.index ?? unavailable,
                channel: attempt.channelId ?? unavailable,
                total: ms(attempt.durationMs),
                before: ms(attempt.gatewayBeforeAttemptMs),
                event: ms(marks.first_event),
                content: ms(marks.first_content),
                text: ms(marks.first_text),
                forward: ms(marks.first_forward),
                forwarding: ms(attempt.firstForwardAfterContentMs),
                missing: attempt.missing.join(', ') || '—',
                http
              })
            })
            .join('\n') +
          '\n' +
          t('turnDiagnostics.serverTiming.missing', { missing: request.missing.join(', ') || '—' })
        )
      })
      .join('\n\n') || unavailable)
  return { performance, summary: summary + '\n\n' + serverSummary }
}
