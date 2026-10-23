import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { CONNECTIVITY_CHECK_REQUEST_HEADERS, TOPIC_NAMING_REQUEST_HEADERS } from '../../packages/shared/diagnostics'
import { listenOnLoopback } from '../../packages/shared/utils/loopbackServer'
import { type InputSizingEvidence, type InputSizingPolicy, sizeInput } from './input-sizing'
import type { RequestBudget } from './live'
import type { MoneyBudget } from './pricing'
import { type Price, type Usage, validatePrice } from './pricing'
import { redact } from './process'
import { describeResponse, QualityResponseParser, type ResponseEvidence } from './response-parser'

type FailureSource = 'budget-gateway' | 'upstream' | 'caller' | 'client'
type FailurePhase = 'request-body' | 'upstream-headers' | 'upstream-body' | 'downstream-body'
type RequestPurpose = 'topic-naming' | 'connectivity-check' | 'context-compaction' | 'main-or-unclassified'
type FailureImpact = 'blocking' | 'warning'

interface RequestEvidence {
  method: string
  path: string
  purpose: RequestPurpose
}

interface RejectedEvidence extends RequestEvidence {
  turnId: string | null
  reason: string
  failureImpact: FailureImpact
  inputSizing?: InputSizingEvidence
}

interface OriginalError {
  name: string
  message: string
  code?: string
  cause?: OriginalError
}

class GatewayAbortError extends Error {
  constructor(
    readonly source: FailureSource,
    readonly code: 'request-timeout' | 'cancelled',
    message: string
  ) {
    super(message)
    this.name = code === 'request-timeout' ? 'TimeoutError' : 'AbortError'
  }
}

function safeText(value: string, secrets: string[]) {
  return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), redact(value)).slice(0, 2000)
}

function originalError(error: unknown, secrets: string[], depth = 0): OriginalError {
  if (!(error instanceof Error)) return { name: 'Error', message: safeText(String(error), secrets) }
  const code = (error as NodeJS.ErrnoException).code
  return {
    name: safeText(error.name, secrets),
    message: safeText(error.message, secrets),
    ...(typeof code === 'string' ? { code: safeText(code, secrets) } : {}),
    ...(error.cause !== undefined && depth < 2 ? { cause: originalError(error.cause, secrets, depth + 1) } : {})
  }
}

export interface CallEvidence {
  sequence: number
  turnId: string
  modelId: string
  startedAt: string
  durationMs: number
  status: number | null
  completed: boolean
  usage: Usage | null
  usageKnown: boolean
  amount: number | null
  amountBasis: string
  firstTextMs: number | null
  headerWaitMs?: number | null
  taskId?: string
  requestId?: string
  requestDigest?: string
  retryable?: boolean
  error?: string
  errorSource?: FailureSource
  errorCode?: string
  errorPhase?: FailurePhase
  originalError?: OriginalError
  method?: string
  path?: string
  purpose?: RequestPurpose
  failureImpact?: FailureImpact
  reservationExceeded?: { input: number; output: number; maxInput: number; maxOutput: number }
  inputSizing?: InputSizingEvidence
  response?: ResponseEvidence
}

/** Missing/unknown purposes and all guard failures stay blocking. */
export const isBlockingCallFailure = (call: CallEvidence) => Boolean(call.error && call.failureImpact !== 'warning')

async function upstreamError(response: Response, secrets: string[]) {
  const reader = response.body?.getReader()
  if (!reader) return {}
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < 8192) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value.subarray(0, 8192 - size))
      size += value.length
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const safe = (item: unknown) => (typeof item === 'string' ? safeText(item, secrets) : undefined)
    return {
      message: safe(value.error?.message),
      code: safe(value.error?.code),
      requestId: safe(value.request_id ?? value.error?.request_id)
    }
  } catch {
    return {}
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export function openAIUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object') return
  const usage = value as Record<string, any>
  const input = usage.prompt_tokens
  const output = usage.completion_tokens
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens
  const cacheWrite = usage.prompt_tokens_details?.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? 0
  // Unknown cache is not zero. Keep the conservative reservation rather than inventing a cache hit/miss.
  if (
    ![input, output, cacheRead, cacheWrite].every((item) => Number.isSafeInteger(item) && item >= 0) ||
    cacheRead + cacheWrite > input
  )
    return
  return { input, output, cacheRead, cacheWrite }
}

async function body(req: IncomingMessage) {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8 * 1024 * 1024) throw new Error('请求体超过质检网关限制。')
    chunks.push(Buffer.from(chunk))
  }
  return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), bytes: size }
}

function drain(response: ServerResponse, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', ready)
      response.off('close', failed)
      response.off('error', failed)
      signal.removeEventListener('abort', failed)
    }
    const ready = () => {
      cleanup()
      resolve()
    }
    const failed = () => {
      cleanup()
      reject(new Error('响应中断/已取消'))
    }
    response.once('drain', ready)
    response.once('close', failed)
    response.once('error', failed)
    signal.addEventListener('abort', failed, { once: true })
    if (signal.aborted || response.destroyed) failed()
  })
}

export async function startBudgetGateway(options: {
  modelId: string
  baseURL: string
  credential: string
  price?: Price
  money?: MoneyBudget
  acknowledgedUnknownCost?: true
  tokens: RequestBudget
  maxInput: number
  maxOutput: number
  timeoutMs: number
  vision?: { maxImageTokensPerRequest: number; acknowledgedTokenBilling: true }
  approximateInputSizing?: boolean
  inputSizing?: InputSizingPolicy
  maxRequestsPerTurn?: number
  signal?: AbortSignal
}) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647)
    throw new Error('单请求超时必须是明确有限的正整数毫秒。')
  const token = randomBytes(32).toString('hex')
  const secrets = [options.credential, token].filter(Boolean)
  if (options.price && options.price.modelId !== options.modelId) throw new Error('报价与授权模型不一致。')
  if (Boolean(options.price) !== Boolean(options.money) || (!options.money && !options.acknowledgedUnknownCost))
    throw new Error('必须选择金额保护或明确确认费用未知的限量模式。')
  const sizingPolicy = options.inputSizing ?? (options.approximateInputSizing ? 'deep-estimate' : 'utf8-bytes')
  if (sizingPolicy === 'estimated-tokens' && (options.money || !options.acknowledgedUnknownCost))
    throw new Error('常规近似Token预检仅用于已确认费用未知的限量批次；金额模式保留保守筛查。')
  let turnId: string | undefined
  const calls: CallEvidence[] = []
  const rejected: RejectedEvidence[] = []
  const active = new Set<AbortController>()
  let stopped = false
  const abort = (source: FailureSource) => {
    stopped = true
    for (const controller of active)
      controller.abort(new GatewayAbortError(source, 'cancelled', '请求已取消，费用可能仍发生。'))
  }
  const cancelled = () => abort('caller')
  options.signal?.addEventListener('abort', cancelled, { once: true })
  const server = createServer(async (req, res) => {
    const connectivityCheck =
      req.headers['x-zen-request-purpose'] === CONNECTIVITY_CHECK_REQUEST_HEADERS['X-Zen-Request-Purpose']
    const requestEvidence: RequestEvidence = {
      method: safeText(req.method ?? 'UNKNOWN', secrets).slice(0, 32),
      // Never retain query strings, fragments, credentials or request bodies in route evidence.
      path: safeText((req.url ?? '').split(/[?#]/, 1)[0], secrets).slice(0, 240),
      purpose: connectivityCheck
        ? 'connectivity-check'
        : req.headers['x-zen-context-compaction'] === 'default-only'
          ? 'context-compaction'
          : req.headers['x-zen-request-purpose'] === TOPIC_NAMING_REQUEST_HEADERS['X-Zen-Request-Purpose']
            ? 'topic-naming'
            : 'main-or-unclassified'
    }
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    if (req.method === 'OPTIONS' && !connectivityCheck) {
      res.writeHead(204).end()
      return
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    if (connectivityCheck && req.method === 'GET' && req.url === '/api/status') {
      const message = '本地质检预算网关不支持上游健康检查；未转发，无法确认真实上游健康状态。'
      rejected.push({
        ...requestEvidence,
        turnId: turnId ?? null,
        reason: message,
        failureImpact: 'warning'
      })
      res.writeHead(501, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(
        JSON.stringify({
          error: {
            message,
            type: 'quality_gateway_error',
            source: 'budget-gateway',
            code: 'connectivity-check-unsupported'
          },
          local: true,
          forwarded: false,
          upstreamHealth: 'unknown'
        })
      )
      return
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: options.modelId, object: 'model', owned_by: 'quality-selected' }]
        })
      )
      return
    }
    // A diagnostic marker authorizes only the two exact local GET routes above, never a model call.
    if (connectivityCheck || req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      rejected.push({
        ...requestEvidence,
        turnId: turnId ?? null,
        reason: '未授权的接口路径/方法；未转发。',
        // A naming adapter's known protocol fallback is still refused, not forwarded.
        // Arbitrary endpoints/methods are never downgraded to harmless auxiliary work.
        failureImpact:
          requestEvidence.purpose === 'topic-naming' && req.method === 'POST' && req.url === '/v1/responses'
            ? 'warning'
            : 'blocking'
      })
      res.writeHead(403).end()
      return
    }
    let moneyId: number | undefined
    let tokenId: number | undefined
    let usage: Usage | undefined
    let completed = false
    let hasOutput = false
    let streaming = false
    let phase: FailurePhase = 'request-body'
    let source: FailureSource = 'budget-gateway'
    const controller = new AbortController()
    const assignedTurn = turnId
    active.add(controller)
    let evidence: CallEvidence | undefined
    let inputSizing: InputSizingEvidence | undefined
    let responseParser: QualityResponseParser | undefined
    const started = performance.now()
    const timer = setTimeout(
      () =>
        controller.abort(
          new GatewayAbortError(
            'budget-gateway',
            'request-timeout',
            `单请求超时（${options.timeoutMs}ms），费用可能仍发生。`
          )
        ),
      options.timeoutMs
    )
    const stopReading = () => {
      if (!req.complete) req.destroy()
    }
    controller.signal.addEventListener('abort', stopReading, { once: true })
    const disconnected = () => {
      if (!res.writableFinished)
        controller.abort(new GatewayAbortError('client', 'cancelled', '下游连接已取消，费用可能仍发生。'))
    }
    res.once('close', disconnected)
    try {
      if (stopped || options.signal?.aborted) {
        throw new GatewayAbortError('caller', 'cancelled', '请求已取消，未转发。')
      }
      if (!assignedTurn) throw new Error('没有已授权的活动任务。')
      const previousFailure = calls.find(
        (call) => call.turnId === assignedTurn && isBlockingCallFailure(call) && !call.retryable
      )
      if (previousFailure) throw new Error(`本轮已失败：${previousFailure.error}；后续请求未转发。`)
      if (options.price) validatePrice(options.price)
      const received = await body(req)
      const request = received.value
      streaming = request.stream === true
      controller.signal.throwIfAborted()
      if (calls.filter((call) => call.turnId === assignedTurn).length >= (options.maxRequestsPerTurn ?? 20))
        throw new Error('本轮模型调用次数达到上限，未继续循环。')
      if (
        request.model !== options.modelId ||
        (request.n !== undefined && request.n !== 1) ||
        !Array.isArray(request.messages)
      )
        throw new Error('模型或请求类型不在授权范围。')
      if (request.service_tier && !['auto', 'default'].includes(request.service_tier))
        throw new Error('未核实加速档位价格，拒绝发送。')
      if (
        request.audio !== undefined ||
        request.web_search_options !== undefined ||
        request.extra_body !== undefined ||
        (request.modalities !== undefined &&
          (!Array.isArray(request.modalities) ||
            request.modalities.some((modality: unknown) => modality !== 'text'))) ||
        (request.tools !== undefined &&
          (!Array.isArray(request.tools) || request.tools.some((tool: any) => tool?.type !== 'function')))
      )
        throw new Error('未核实音频、服务端工具或额外计价参数，拒绝发送。')
      let images = 0
      const messages = request.messages.map((message: any) => ({
        ...message,
        content: Array.isArray(message.content)
          ? message.content.map((part: any) => {
              if (part.type === 'text') return part
              if (
                part.type !== 'image_url' ||
                !options.vision ||
                typeof part.image_url?.url !== 'string' ||
                !/^data:image\/(?:png|jpeg);base64,/.test(part.image_url.url)
              )
                throw new Error('未批准的多模态内容/外部URL，不转发；图片需核实Token计价。')
              images++
              return { type: 'image_url', image_url: { url: '[authorized synthetic image]' } }
            })
          : message.content
      }))
      const serialized = JSON.stringify({ messages, tools: request.tools ?? [] })
      const imageTokens = images ? options.vision!.maxImageTokensPerRequest : 0
      inputSizing = sizeInput(serialized, {
        strategy: sizingPolicy,
        requestBytes: received.bytes,
        imageTokens,
        maxInputTokens: options.maxInput
      })
      if (inputSizing.estimatedInputTokens > options.maxInput)
        throw new Error(
          `输入预检超出单请求Token预留：${inputSizing.estimatedInputTokens}/${options.maxInput}（预检/预留）；策略=${sizingPolicy}，文本与工具UTF-8字节=${inputSizing.textAndToolsBytes}，近似Token=${inputSizing.approximateTokens}，倍数=${inputSizing.safetyMultiplier}，图像=${imageTokens}，协议余量=${inputSizing.overheadTokens}。预检不是实测Token，未发送上游。`
        )
      const outputLimitKey = 'max_completion_tokens' in request ? 'max_completion_tokens' : 'max_tokens'
      const requestedOutput = request[outputLimitKey]
      if (requestedOutput !== undefined && (!Number.isSafeInteger(requestedOutput) || requestedOutput <= 0))
        throw new Error('请求输出Token限制必须是正整数。')
      // Cap an oversized native limit, but never inflate a smaller naming/answer limit.
      request[outputLimitKey] = Math.min(requestedOutput ?? options.maxOutput, options.maxOutput)
      if (outputLimitKey === 'max_completion_tokens') delete request.max_tokens
      if (request.stream) request.stream_options = { ...request.stream_options, include_usage: true }
      try {
        if (options.money && options.price)
          moneyId = options.money.reserve(options.price, options.maxInput, options.maxOutput)
        tokenId = options.tokens.reserve(options.maxInput, options.maxOutput)
      } catch (error) {
        // Reservation was not sent: release it explicitly, not as an unknown paid request.
        if (moneyId !== undefined) options.money!.releaseUnsent(moneyId)
        moneyId = undefined
        options.tokens.stop()
        options.money?.stop()
        throw error
      }
      evidence = {
        ...requestEvidence,
        sequence: calls.length + 1,
        turnId: assignedTurn,
        modelId: request.model,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        status: null,
        completed: false,
        usage: null,
        usageKnown: false,
        amount: null,
        amountBasis: options.money ? 'pending' : 'unpriced',
        firstTextMs: null,
        headerWaitMs: null,
        inputSizing,
        requestDigest: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
        taskId: typeof req.headers['x-zen-task-id'] === 'string' ? req.headers['x-zen-task-id'] : undefined
      }
      calls.push(evidence)
      const target = new URL(options.baseURL.replace(/\/$/, '') + '/chat/completions')
      phase = 'upstream-headers'
      source = 'upstream'
      const upstream = await fetch(target, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.credential}`,
          ...(requestEvidence.purpose === 'topic-naming' ? TOPIC_NAMING_REQUEST_HEADERS : {}),
          ...(evidence.taskId ? { 'X-Zen-Task-Id': evidence.taskId } : {}),
          ...(typeof req.headers.originator === 'string' ? { Originator: req.headers.originator } : {}),
          ...(typeof req.headers['user-agent'] === 'string' ? { 'User-Agent': req.headers['user-agent'] } : {})
        },
        body: JSON.stringify(request)
      })
      phase = 'upstream-body'
      evidence.headerWaitMs = performance.now() - started
      evidence.status = upstream.status
      responseParser = new QualityResponseParser(
        request.stream === true,
        upstream.headers.get('content-type'),
        (json) => {
          if (json.error) {
            const message = typeof json.error.message === 'string' ? safeText(json.error.message, secrets) : ''
            throw Object.assign(new Error(`上游返回错误事件，未自动重试。${message}`), {
              code: typeof json.error.code === 'string' ? safeText(json.error.code, secrets) : undefined
            })
          }
          if (json.usage) usage = openAIUsage(json.usage)
          hasOutput = responseParser!.evidence.hasText || responseParser!.evidence.hasToolCalls
          if (
            responseParser!.evidence.hasText &&
            (!request.stream || responseParser!.evidence.framing === 'sse') &&
            evidence!.firstTextMs === null
          )
            evidence!.firstTextMs = performance.now() - started
          if (responseParser!.evidence.finishReasons.includes('error'))
            throw new Error('上游返回失败完成状态，未自动重试。')
        }
      )
      evidence.response = responseParser.evidence
      const requestId = ['x-oneapi-request-id', 'x-request-id', 'request-id']
        .map((header) => upstream.headers.get(header))
        .find((value) => value && /^[\w.-]{1,200}$/.test(value) && safeText(value, secrets) === value)
      if (requestId) evidence.requestId = requestId
      if (evidence.requestId) res.setHeader('x-request-id', evidence.requestId)
      if (!upstream.ok || !upstream.body) {
        responseParser.evidence.outcome = 'http-error'
        evidence.retryable = [408, 429].includes(upstream.status) || upstream.status >= 500
        const detail = await upstreamError(upstream, secrets)
        controller.signal.throwIfAborted()
        if (!evidence.requestId && detail.requestId && /^[\w.-]{1,200}$/.test(detail.requestId))
          evidence.requestId = detail.requestId
        if (evidence.requestId) res.setHeader('x-request-id', evidence.requestId)
        throw Object.assign(new Error(`上游HTTP ${upstream.status}${detail.message ? `：${detail.message}` : ''}`), {
          code: detail.code
        })
      }
      res.writeHead(200, {
        'content-type': request.stream ? 'text/event-stream' : 'application/json',
        'cache-control': 'no-store'
      })
      // Forward real upstream headers immediately, without inventing SSE data/heartbeats.
      // Non-streaming JSON keeps its existing content semantics.
      if (request.stream) res.flushHeaders()
      for await (const chunk of upstream.body as any as AsyncIterable<Uint8Array>) {
        responseParser.push(chunk)
        if (!res.write(chunk)) {
          phase = 'downstream-body'
          await drain(res, controller.signal)
          phase = 'upstream-body'
        }
      }
      responseParser.finish()
      completed = true
      res.end()
    } catch (error) {
      completed = false
      responseParser?.interrupted()
      const reason = controller.signal.reason
      const abortError =
        reason instanceof GatewayAbortError ? reason : error instanceof GatewayAbortError ? error : undefined
      const errorSource = abortError?.source ?? source
      const errorCode =
        abortError?.code ??
        (source === 'budget-gateway'
          ? 'gateway-rejected'
          : evidence?.status && evidence.status >= 400
            ? 'upstream-http-error'
            : phase === 'upstream-headers'
              ? 'upstream-failure'
              : streaming
                ? 'upstream-stream-error'
                : 'upstream-body-error')
      const original = originalError(error, secrets)
      const responseSummary = responseParser ? `；${describeResponse(responseParser.evidence)}` : ''
      const message = `[${errorSource}/${errorCode}] ${safeText(abortError?.message ?? original.message, secrets)} (phase=${phase})${responseSummary}`
      if (!evidence)
        rejected.push({
          ...requestEvidence,
          turnId: assignedTurn ?? null,
          reason: message,
          failureImpact: 'blocking',
          ...(inputSizing ? { inputSizing } : {})
        })
      if (evidence)
        Object.assign(evidence, {
          error: message,
          errorSource,
          errorCode,
          errorPhase: phase,
          originalError: original,
          failureImpact:
            requestEvidence.purpose === 'topic-naming' &&
            !stopped &&
            !options.signal?.aborted &&
            (errorSource === 'upstream' || errorSource === 'client' || errorCode === 'request-timeout')
              ? 'warning'
              : 'blocking'
        })
      if (evidence)
        evidence.retryable =
          !abortError &&
          !hasOutput &&
          !stopped &&
          !options.signal?.aborted &&
          (evidence.retryable === true || evidence.status === null)
      // Stop any unread upstream body on all failures, not just timer/caller aborts.
      // Classify first so this cleanup never turns a transport failure into a cancellation.
      controller.signal.removeEventListener('abort', stopReading)
      controller.abort()
      const payload = {
        error: {
          message,
          type: 'quality_gateway_error',
          source: errorSource,
          code: errorCode,
          phase,
          originalError: original,
          ...(evidence?.requestId ? { request_id: evidence.requestId } : {})
        }
      }
      if (!res.headersSent)
        res
          .writeHead(
            errorCode === 'request-timeout' ? 504 : evidence?.status && evidence.status >= 400 ? evidence.status : 502,
            {
              'content-type': 'application/json'
            }
          )
          .end(JSON.stringify(payload))
      else if (streaming && !res.destroyed) res.end(`\n\ndata: ${JSON.stringify(payload)}\n\n`)
      else res.destroy()
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', stopReading)
      active.delete(controller)
      res.removeListener('close', disconnected)
      if (tokenId !== undefined) options.tokens.settle(tokenId, usage)
      if (usage && (usage.input > options.maxInput || usage.output > options.maxOutput)) {
        options.money?.stop()
        options.tokens.stop()
        if (evidence) {
          evidence.error = `[budget-gateway/request-token-limit] 上游用量超过单请求已批准预留：输入${usage.input}/${options.maxInput}、输出${usage.output}/${options.maxOutput} Token（已用/预留，输出包含上游计入的推理Token）；停止后续请求。`
          evidence.errorSource = 'budget-gateway'
          evidence.errorCode = 'request-token-limit'
          evidence.errorPhase = 'upstream-body'
          evidence.reservationExceeded = {
            input: usage.input,
            output: usage.output,
            maxInput: options.maxInput,
            maxOutput: options.maxOutput
          }
          evidence.failureImpact = 'blocking'
          evidence.retryable = false
        }
      }
      if (moneyId !== undefined) {
        const settled = options.money!.settle(moneyId, options.price!, usage)
        if (evidence) Object.assign(evidence, { amount: settled.amount, amountBasis: settled.basis })
      }
      if (evidence)
        Object.assign(evidence, {
          durationMs: performance.now() - started,
          usage: usage ?? null,
          usageKnown: Boolean(usage),
          completed
        })
    }
  })
  await listenOnLoopback(server)
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    token,
    calls,
    rejected,
    beginTurn(id: string) {
      if (active.size) throw new Error('前一轮请求仍在运行。')
      turnId = id
    },
    isIdle: () => active.size === 0,
    assertTurnHealthy(id: string, awaitingRetry = false) {
      const failure = calls.find(
        (call) =>
          call.turnId === id &&
          isBlockingCallFailure(call) &&
          (!call.retryable ||
            (!awaitingRetry &&
              !calls.some(
                (recovery) =>
                  recovery.turnId === id &&
                  recovery.sequence > call.sequence &&
                  recovery.purpose === call.purpose &&
                  recovery.requestDigest === call.requestDigest &&
                  recovery.completed &&
                  !recovery.error
              )))
      )
      if (failure) throw new Error(`底层请求失败：${failure.error}`)
      const rejection = rejected.find((call) => call.turnId === id && call.failureImpact !== 'warning')
      if (rejection) throw new Error(`底层请求被拒绝：${rejection.method} ${rejection.path}：${rejection.reason}`)
    },
    turnWarnings(id: string) {
      return [
        ...calls
          .filter((call) => call.turnId === id && call.error && call.failureImpact === 'warning')
          .map((call) => `自动命名失败（${call.method} ${call.path}）：${call.error}；不影响主回答，保留本地标题。`),
        ...rejected
          .filter((call) => call.turnId === id && call.failureImpact === 'warning')
          .map((call) =>
            call.purpose === 'connectivity-check'
              ? `连通性诊断未转发（${call.method} ${call.path}）：${call.reason}；不影响主回答。`
              : `自动命名接口未转发（${call.method} ${call.path}）：${call.reason}；保留本地标题。`
          )
      ]
    },
    async close() {
      abort('budget-gateway')
      options.signal?.removeEventListener('abort', cancelled)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      const deadline = performance.now() + 5000
      while (active.size && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
      if (active.size) throw new Error('网关仍有在途请求，费用待对账，不能当作正常结束。')
    }
  }
}
