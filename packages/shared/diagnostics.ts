import { getModelDailyQuotaErrorKind } from './utils/modelDailyQuota'

/** Bounded, content-free request evidence shared by main and renderer. */
export const DIAGNOSTIC_OPERATION_HEADER = 'X-Zen-Diagnostic-Operation'
export const DIAGNOSTIC_TRACE_HEADER = 'X-Zen-Trace-Id'
/** Explicit auxiliary purpose, never inferred from streaming, timing or prompt text. */
export const TOPIC_NAMING_REQUEST_HEADERS = { 'X-Zen-Request-Purpose': 'topic-naming' } as const
/** Read-only diagnostics, not a model generation or a user turn. */
export const CONNECTIVITY_CHECK_REQUEST_HEADERS = { 'X-Zen-Request-Purpose': 'connectivity-check' } as const
const MAX_TEXT = 8_000
const credentialKey =
  /^(?:(?:.*[-_])?(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|secret|password|credential|cookie|set[-_]?cookie|token|permit)|x-zen-model-turn)$/i
const credentialSuffix = /(?:apiKey|accessToken|refreshToken|password|secret|credential|authorization|cookie|permit)$/i

export function diagnosticText(value: string): string {
  let text = value.replace(/\b(?:https?|wss?|socks(?:4a?|5h?)?):\/\/[^\s"'<>\\]+/gi, (raw) => {
    try {
      const url = new URL(raw)
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/(?:sk-[\w-]+|key\/[^/]+)/gi, '/[REDACTED]')}`
    } catch {
      return '[INVALID_URL]'
    }
  })
  text = text
    .replace(/\bdata:[^,\s]*,[^\s"'<>\\]+/gi, '[REDACTED_DATA_URL]')
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, '$1[REDACTED]')
    .replace(
      /((?:["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|token|secret|password|credential|cookie|permit|x-zen-model-turn)["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
  if (text.length <= MAX_TEXT) return text
  return `${text.slice(0, MAX_TEXT / 2)}\n...[truncated ${text.length - MAX_TEXT} characters]...\n${text.slice(-MAX_TEXT / 2)}`
}

export function sanitizeDiagnostic(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 10) return '[Max depth reached]'
  if (typeof value === 'string') {
    // SDK causes/request bodies frequently arrive as JSON strings.
    if (/^\s*[[{]/.test(value)) {
      try {
        return diagnosticText(JSON.stringify(sanitizeDiagnostic(JSON.parse(value), depth + 1, seen)))
      } catch {
        /* Not JSON: redact as plain text. */
      }
    }
    return diagnosticText(value)
  }
  if (typeof value === 'bigint') return String(value)
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  let result: unknown
  if (Array.isArray(value)) {
    const items =
      value.length > 256
        ? [...value.slice(0, 64), `[truncated ${value.length - 256} entries]`, ...value.slice(-192)]
        : value
    result = items.map((item) => sanitizeDiagnostic(item, depth + 1, seen))
  } else {
    const entries =
      value instanceof Error
        ? { ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause }
        : (value as Record<string, unknown>)
    result = Object.fromEntries(
      Object.entries(entries)
        .slice(0, 256)
        .map(([key, item]) => [
          key,
          credentialKey.test(key) ||
          credentialSuffix.test(key) ||
          key === 'env_vars' ||
          /^(?:base64|imageData|fileData)$/i.test(key)
            ? '[REDACTED]'
            : sanitizeDiagnostic(item, depth + 1, seen)
        ])
    )
  }
  seen.delete(value)
  return result
}

export type DiagnosticStage =
  | 'client'
  | 'preparation'
  | 'context'
  | 'runtime'
  | 'transport'
  | 'response'
  | 'ui'
  | 'storage'
  | 'tool'
export type DiagnosticEvent = {
  at: string
  stage: DiagnosticStage
  event: string
  details?: Record<string, unknown>
}
export type DiagnosticEvidence = {
  operationId: string
  startedAt: string
  updatedAt: string
  metadata: Record<string, unknown>
  events: DiagnosticEvent[]
  droppedEvents: number
}

export class DiagnosticRecorder {
  private records = new Map<string, DiagnosticEvidence>()
  constructor(
    private readonly capacity = 100,
    private readonly maxEvents = 160
  ) {}

  begin(operationId: string, metadata: Record<string, unknown> = {}): DiagnosticEvidence {
    const now = new Date().toISOString()
    const record: DiagnosticEvidence = {
      operationId,
      startedAt: now,
      updatedAt: now,
      metadata: sanitizeDiagnostic(metadata) as Record<string, unknown>,
      events: [],
      droppedEvents: 0
    }
    this.records.delete(operationId)
    this.records.set(operationId, record)
    while (this.records.size > this.capacity) this.records.delete(this.records.keys().next().value!)
    return record
  }

  record(
    operationId: string | undefined,
    stage: DiagnosticStage,
    event: string,
    details?: Record<string, unknown>
  ): void {
    if (!operationId) return
    const record = this.records.get(operationId) ?? this.begin(operationId)
    record.updatedAt = new Date().toISOString()
    record.events.push({
      at: record.updatedAt,
      stage,
      event,
      details: sanitizeDiagnostic(details) as Record<string, unknown> | undefined
    })
    if (record.events.length > this.maxEvents) {
      record.events.splice(Math.floor(this.maxEvents / 3), 1)
      record.droppedEvents += 1
    }
  }

  get(operationId: string): DiagnosticEvidence | undefined {
    const record = this.records.get(operationId)
    return record ? structuredClone(record) : undefined
  }
}

export type DiagnosticAttribution = {
  owner: 'zen-ai' | 'zen-api' | 'network-or-proxy' | 'undetermined'
  stage: string
  confidence: 'confirmed' | 'suspected' | 'insufficient'
  explanation: string
  evidence: string[]
}

export function attributeDiagnostic(
  events: DiagnosticEvent[],
  backend: Array<Record<string, unknown>> = [],
  savedError?: unknown
): DiagnosticAttribution {
  const facts = events.map((item) => `${item.stage}:${item.event}`)
  const finalError = [...events].reverse().find((item) => item.event === 'failed')
  // An earlier checkpoint/failed-key request is not evidence about the final
  // completion. Correlate only the final observed HTTP attempt when available.
  const lastRequestIndex = events.findLastIndex(
    (item) => item.stage === 'transport' && item.event === 'request-started'
  )
  const lastAttemptIndex = events.findLastIndex((item) => item.stage === 'response' && item.event === 'attempt-started')
  const lastRequest = events[lastRequestIndex]
  const finalAttemptHasRequest = lastRequestIndex >= lastAttemptIndex
  const transportEvents = finalAttemptHasRequest
    ? events.filter(
        (item, index) =>
          item.stage === 'transport' &&
          (lastRequest?.details?.traceId
            ? item.details?.traceId === lastRequest.details.traceId
            : index >= Math.max(0, lastRequestIndex))
      )
    : []
  const lastHeaders = [...transportEvents].reverse().find((item) => item.event === 'headers-received')
  const relatedBackend = lastRequest
    ? finalAttemptHasRequest
      ? backend.filter(
          (item) =>
            (lastHeaders?.details?.requestId && item.requestId === lastHeaders.details.requestId) ||
            (lastRequest.details?.traceId && item.traceId === lastRequest.details.traceId)
        )
      : []
    : backend
  const lastBackend = [...relatedBackend]
    .sort((a, b) => String(a.finishedAt ?? a.startedAt).localeCompare(String(b.finishedAt ?? b.startedAt)))
    .at(-1)
  const apiFailure =
    lastBackend?.outcome === 'failed' && lastBackend.clientDisconnected !== true ? lastBackend : undefined
  const startupFailure = [...events]
    .reverse()
    .find((item) => item.stage === 'runtime' && item.event === 'failed' && item.details?.startup === true)
  const completedTransport = transportEvents.some((item) => item.event === 'body-complete')
  // Local runtime deadlines can be wrapped in a model SDK error after HTTP
  // succeeded. Inspect only the terminal error, never a recovered earlier one.
  let terminalError: unknown = finalError?.details?.error ?? savedError
  for (let depth = 0; depth < 4 && terminalError && typeof terminalError === 'object'; depth++) {
    const error = terminalError as Record<string, unknown>
    if (
      error.zenFailureStage === 'local-task-deadline' ||
      ['agent_human_wait_timeout', 'agent_execution_timeout', 'agent_inactivity_timeout'].includes(String(error.code))
    ) {
      return {
        owner: 'zen-ai',
        stage: 'local-task-deadline',
        confidence: 'confirmed',
        explanation:
          error.code === 'agent_human_wait_timeout'
            ? '任务在本地等待用户确认或操作时超过时限，应检查确认入口和等待原因；此前 HTTP 成功不代表任务仍在生成。'
            : '智能助手本地任务计时器结束了本次任务；计时器触发位置明确，具体停滞原因仍需结合时间线判断。',
        evidence: [
          finalError ? JSON.stringify(finalError) : `saved-message-error:${String(error.code ?? error.zenFailureStage)}`
        ]
      }
    }
    terminalError = error.cause
  }
  const localFailure = [...events]
    .reverse()
    .find(
      (item) =>
        item.event === 'failed' &&
        ['preparation', 'context', 'ui', 'storage'].includes(item.stage) &&
        !getModelDailyQuotaErrorKind(item.details?.error)
    )
  if (localFailure) {
    return {
      owner: 'zen-ai',
      stage: localFailure.stage,
      confidence: 'confirmed',
      explanation: 'Zen AI 在本地处理环节记录了明确异常。',
      evidence: [JSON.stringify(localFailure)]
    }
  }
  if (
    startupFailure &&
    !events
      .slice(events.indexOf(startupFailure) + 1)
      .some(
        (item) =>
          item.stage === 'runtime' &&
          ['selected', 'fallback', 'transport-config', 'started', 'visible-output', 'complete'].includes(item.event)
      )
  ) {
    return {
      owner: 'zen-ai',
      stage: 'runtime',
      confidence: 'confirmed',
      explanation: '智能助手本地运行组件启动失败；此记录不证明模型服务收到请求。',
      evidence: [JSON.stringify(startupFailure)]
    }
  }
  const processExit = [...events]
    .reverse()
    .find(
      (item) =>
        item.stage === 'runtime' &&
        item.event === 'process-exit' &&
        item.details?.runtime === 'opencode' &&
        item.details?.unexpected === true &&
        item.details?.active === true
    )
  if (
    processExit &&
    !events
      .slice(events.indexOf(processExit) + 1)
      .some(
        (item) =>
          item.stage === 'runtime' &&
          ['process-spawned', 'process-health', 'started', 'visible-output', 'complete'].includes(item.event)
      )
  ) {
    return {
      owner: 'zen-ai',
      stage: 'runtime-process',
      confidence: 'confirmed',
      explanation:
        'OpenCode 本地进程在任务进行期间意外退出；退出位置已确认，根因需结合标准错误、退出码和系统崩溃报告判断。',
      evidence: [JSON.stringify(processExit)]
    }
  }
  const quotaFailure = [...events]
    .reverse()
    .find(
      (item) =>
        ['failed', 'quota-refused'].includes(item.event) &&
        (item.details?.phase === 'quota-admission' || getModelDailyQuotaErrorKind(item.details?.error))
    )
  if (
    quotaFailure &&
    !events
      .slice(events.indexOf(quotaFailure) + 1)
      .some(
        (item) =>
          (item.stage === 'transport' &&
            ['quota-check-complete', 'request-started', 'body-complete'].includes(item.event)) ||
          (item.stage === 'runtime' && item.event === 'complete')
      )
  )
    return {
      owner: 'undetermined',
      stage: 'quota-admission',
      confidence: 'confirmed',
      explanation:
        '请求停在模型请求前校验环节，尚未发起本次模型调用；连接超时、后台异常与明确的额度拒绝需结合校验接口的响应或服务器日志区分，不能仅凭此错误认定额度耗尽或客户端程序故障。',
      evidence: [JSON.stringify(quotaFailure)]
    }
  if (apiFailure?.failureStage === 'downstream-delivery')
    return {
      owner: 'network-or-proxy',
      stage: 'downstream-delivery',
      confidence: 'suspected',
      explanation: 'Zen API 写回客户端时失败。故障位于返回链路，不能据此认定模型或客户端程序故障。',
      evidence: [String(apiFailure.requestId)]
    }
  if (apiFailure) {
    return {
      owner: 'zen-api',
      stage: String(apiFailure.failureStage ?? 'gateway-or-upstream'),
      confidence: 'confirmed',
      explanation: 'Zen API 记录了请求失败，具体区分网关、渠道及上游请查看后台证据。',
      evidence: [String(apiFailure.requestId ?? ''), String(apiFailure.failureStage ?? '')]
    }
  }
  if (completedTransport && finalError?.stage === 'response') {
    const error = finalError.details?.error as Record<string, unknown> | undefined
    if (/^AI_(?:APICall|ProviderSpecific)Error$/.test(String(error?.name ?? ''))) {
      return {
        owner: lastHeaders?.details?.gateway === true ? 'zen-api' : 'undetermined',
        stage: 'gateway-or-upstream-response',
        confidence: 'suspected',
        explanation:
          'HTTP 响应读取完成，但模型 SDK 报告接口错误，可能是响应中的上游错误；完整读取不代表返回的是有效回答，不能认定为客户端解析故障。',
        evidence: ['transport:body-complete', JSON.stringify(finalError)]
      }
    }
    return {
      owner: 'zen-ai',
      stage: 'response',
      confidence: 'confirmed',
      explanation: '客户端已读取完 HTTP 响应，但随后处理失败；是否因响应格式不兼容，需要结合解析错误判断。',
      evidence: ['transport:body-complete', JSON.stringify(finalError)]
    }
  }
  const httpFailure =
    Number(lastHeaders?.details?.status) >= 400 && lastHeaders?.details?.gateway === true ? lastHeaders : undefined
  if (httpFailure) {
    return {
      owner: 'zen-api',
      stage: 'http-response',
      confidence: 'confirmed',
      explanation: '收到带 Zen API 标识的 HTTP 错误响应；错误属于网关处理或其上游，不能仅凭状态码细分。',
      evidence: [JSON.stringify(httpFailure)]
    }
  }
  if (transportEvents.some((item) => item.event === 'failed')) {
    return {
      owner: 'network-or-proxy',
      stage: 'transport',
      confidence: 'suspected',
      explanation: '客户端连接或读取中断；网络、代理、网关断开均可能，当前证据不足以确定责任端。',
      evidence: transportEvents.map((item) => JSON.stringify(item))
    }
  }
  if (
    lastBackend?.outcome === 'succeeded' &&
    lastBackend.clientDisconnected !== true &&
    Number(lastBackend.writtenBytes) > 0 &&
    finalError
  ) {
    return {
      owner: 'zen-ai',
      stage: 'response-or-runtime-consumption',
      confidence: 'suspected',
      explanation:
        'Zen API 已记录成功处理并写出响应，Zen AI 未完成接收或处理。优先检查客户端及返回链路；后台写出不代表客户端一定收到完整内容。',
      evidence: [String(lastBackend.requestId), JSON.stringify(finalError)]
    }
  }
  if (lastBackend?.outcome === 'pending') {
    return {
      owner: 'undetermined',
      stage: 'gateway-processing',
      confidence: 'insufficient',
      explanation:
        'Zen API 已收到请求，但查询时尚无最终结果。可能仍在生成或终态证据缺失，不能据此把客户端超时归咎于某一端。',
      evidence: [String(lastBackend.requestId)]
    }
  }
  return {
    owner: 'undetermined',
    stage: finalError?.stage ?? 'unknown',
    confidence: 'insufficient',
    explanation: '现有证据不足以确定故障端。请使用请求编号关联 Zen API 日志；未查到记录不代表请求没有到达。',
    evidence: facts.slice(-12)
  }
}

export type RecordDiagnostic = (
  id: string | undefined,
  stage: DiagnosticStage,
  event: string,
  details?: Record<string, unknown>
) => void

export async function diagnosticKeyFingerprint(value: string): Promise<string | undefined> {
  try {
    const hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value.replace(/^Bearer\s+/i, '').trim())
    )
    return Array.from(new Uint8Array(hash))
      .slice(0, 12)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return undefined
  }
}

/** Observe bytes without retaining prompts, response content or buffering the stream. */
export function diagnosticFetch(baseFetch: typeof fetch, record: RecordDiagnostic): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const operationId = headers.get(DIAGNOSTIC_OPERATION_HEADER) ?? undefined
    const traceId = headers.get(DIAGNOSTIC_TRACE_HEADER) || `zen_${crypto.randomUUID()}`
    headers.set(DIAGNOSTIC_TRACE_HEADER, traceId)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const startedAt = Date.now()
    const request: Record<string, unknown> = {
      traceId,
      url: diagnosticText(url),
      method: init?.method ?? (input instanceof Request ? input.method : 'GET')
    }
    const credential =
      headers.get('authorization') ??
      headers.get('x-api-key') ??
      headers.get('api-key') ??
      headers.get('x-goog-api-key')
    if (credential) request.keyFingerprint = await diagnosticKeyFingerprint(credential)
    if (typeof init?.body === 'string') {
      request.bodyBytes = new TextEncoder().encode(init.body).length
      try {
        const body = JSON.parse(init.body)
        Object.assign(request, {
          model: body.model,
          stream: body.stream,
          messageCount: body.messages?.length ?? body.input?.length,
          toolCount: body.tools?.length ?? 0,
          fields: Object.keys(body).sort()
        })
      } catch {
        request.bodyType = 'non-json'
      }
    }
    record(operationId, 'transport', 'request-started', request)
    let response: Response
    try {
      response = await baseFetch(input, { ...init, headers })
    } catch (error) {
      record(operationId, 'transport', 'failed', {
        traceId,
        elapsedMs: Date.now() - startedAt,
        phase: 'connect',
        error
      })
      if (error && typeof error === 'object') {
        try {
          Object.assign(error, { zenTraceId: traceId, zenDiagnosticId: operationId, zenRequestUrl: url })
        } catch {
          /* A frozen error must retain its original identity and message. */
        }
      }
      throw error
    }
    const requestId = response.headers.get('x-oneapi-request-id') ?? response.headers.get('x-request-id') ?? undefined
    record(operationId, 'transport', 'headers-received', {
      traceId,
      requestId,
      url: diagnosticText(url),
      status: response.status,
      gateway: response.headers.has('x-new-api-version'),
      apiVersion: response.headers.get('x-new-api-version'),
      contentType: response.headers.get('content-type'),
      elapsedMs: Date.now() - startedAt
    })
    if (!response.body || !response.ok) return response
    const reader = response.body.getReader()
    let bytes = 0
    let chunks = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read()
          if (result.done) {
            record(operationId, 'transport', 'body-complete', {
              traceId,
              requestId,
              bytes,
              chunks,
              elapsedMs: Date.now() - startedAt
            })
            reader.releaseLock()
            controller.close()
          } else {
            bytes += result.value.byteLength
            chunks += 1
            if (chunks === 1)
              record(operationId, 'transport', 'first-bytes', { traceId, requestId, elapsedMs: Date.now() - startedAt })
            controller.enqueue(result.value)
          }
        } catch (error) {
          record(operationId, 'transport', 'failed', { traceId, requestId, phase: 'read', bytes, chunks, error })
          if (error && typeof error === 'object') {
            try {
              Object.assign(error, { zenTraceId: traceId, zenDiagnosticId: operationId, zenRequestUrl: url })
            } catch {
              /* Best effort only. */
            }
          }
          reader.releaseLock()
          controller.error(error)
        }
      },
      async cancel(reason) {
        record(operationId, 'transport', 'cancelled', { traceId, requestId, bytes, chunks, reason })
        try {
          await reader.cancel(reason)
        } finally {
          reader.releaseLock()
        }
      }
    })
    const observed = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
    Object.defineProperty(observed, 'url', { value: response.url })
    return observed
  }
}
