import type { Model } from '@renderer/types'
import type { SerializedError } from '@renderer/types/error'

type DiagnosisCategory =
  | 'account'
  | 'rate_limited'
  | 'service'
  | 'network'
  | 'stream'
  | 'timeout'
  | 'payload'
  | 'context'
  | 'model'
  | 'response'
  | 'content'
  | 'unknown'

export interface ClientErrorDiagnosis {
  category: DiagnosisCategory
  title: string
  summary: string
  stage: string
  errorType: string
  httpStatus: string
  serviceConnectivity: string
  serviceStatusCheck: string
  modelApiCheck: string
  serviceReceived: string
  startedGenerating: string
  model: string
  serviceAddress: string
  occurredAt: string
  diagnosticId: string
  suggestion: string
}

export interface ConnectivityProbeResult {
  ok: boolean
  reachable: boolean
  status?: number
  durationMs?: number
  error?: string
}

export interface ClientConnectivityCheck {
  checkedAt: string
  serviceStatus?: ConnectivityProbeResult
  modelsApi?: ConnectivityProbeResult
}

interface DiagnoseOptions {
  model?: Model
  blockId?: string
  messageId?: string
  createdAt?: string
}

const UNKNOWN = '未确认'
const NOT_AVAILABLE = '-'
export const ZEN_TRACE_HEADER = 'X-Zen-Trace-Id'
const CONNECTIVITY_CHECK_TIMEOUT_MS = 5000

export function createZenTraceId(date = new Date()): string {
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date
  const stamp = `${safeDate.getFullYear()}${String(safeDate.getMonth() + 1).padStart(2, '0')}${String(
    safeDate.getDate()
  ).padStart(2, '0')}${String(safeDate.getHours()).padStart(2, '0')}${String(safeDate.getMinutes()).padStart(
    2,
    '0'
  )}${String(safeDate.getSeconds()).padStart(2, '0')}`
  const randomPart = Math.random().toString(36).slice(2, 10)
  return `zen_${stamp}_${randomPart}`
}

function readStatus(error?: SerializedError): number | undefined {
  const status = error && ((error as Record<string, unknown>).statusCode ?? (error as Record<string, unknown>).status)
  if (typeof status === 'number') return status
  if (typeof status === 'string') {
    const parsed = Number.parseInt(status, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function readUrl(error?: SerializedError): string {
  const url = error && ((error as Record<string, unknown>).url ?? (error as Record<string, unknown>).zenRequestUrl)
  if (typeof url !== 'string' || !url) return NOT_AVAILABLE

  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.split('?')[0] || NOT_AVAILABLE
  }
}

function readConnectivityCheck(error?: SerializedError): ClientConnectivityCheck | undefined {
  const raw = error && (error as Record<string, unknown>).zenConnectivityCheck
  if (!raw || typeof raw !== 'object') return undefined
  return raw as ClientConnectivityCheck
}

function formatProbeResult(result?: ConnectivityProbeResult): string {
  if (!result) return UNKNOWN
  const cost = result.durationMs != null ? `，${Math.round(result.durationMs)}ms` : ''
  if (result.reachable && result.ok) return `正常${cost}`
  if (result.reachable && result.status != null) return `可访问，但返回 HTTP ${result.status}${cost}`
  return result.error ? `失败：${result.error}` : '失败：无响应'
}

function serviceConnectivityFromCheck(check: ClientConnectivityCheck | undefined, fallback: string): string {
  if (!check?.serviceStatus) return fallback
  if (check.serviceStatus.reachable && check.serviceStatus.ok) return '正常'
  if (check.serviceStatus.reachable) return '可访问'
  return '失败'
}

function normalizeMessage(error?: SerializedError): string {
  const parts = [error?.name, error?.message, error?.stack, (error as Record<string, unknown> | undefined)?.cause]
    .filter((item): item is string => typeof item === 'string')
    .join('\n')
  return parts.toLowerCase()
}

function formatTime(value?: string): string {
  if (!value) return new Date().toLocaleString()
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function buildDiagnosticId(blockId?: string, messageId?: string, createdAt?: string): string {
  const source = blockId || messageId || Math.random().toString(36).slice(2)
  const suffix = source
    .replace(/[^a-z0-9]/gi, '')
    .slice(-6)
    .toUpperCase()
    .padStart(6, '0')
  const date = createdAt ? new Date(createdAt) : new Date()
  const time = Number.isNaN(date.getTime()) ? new Date() : date
  const stamp = `${time.getFullYear()}${String(time.getMonth() + 1).padStart(2, '0')}${String(time.getDate()).padStart(
    2,
    '0'
  )}-${String(time.getHours()).padStart(2, '0')}${String(time.getMinutes()).padStart(2, '0')}${String(
    time.getSeconds()
  ).padStart(2, '0')}`
  return `ZEN-${stamp}-${suffix}`
}

function modelLabel(model?: Model): string {
  return model?.id || model?.name || NOT_AVAILABLE
}

function getFetchUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function buildConnectivityUrl(sourceUrl: string, path: string): string | undefined {
  try {
    const url = new URL(sourceUrl)
    return `${url.origin}${path}`
  } catch {
    return undefined
  }
}

function getAuthHeaders(init?: RequestInit): Headers {
  const source = new Headers(init?.headers)
  const headers = new Headers()
  const authorization = source.get('authorization')
  const apiKey = source.get('api-key') || source.get('x-api-key')

  headers.set('accept', 'application/json')
  if (authorization) headers.set('authorization', authorization)
  if (apiKey) headers.set('x-api-key', apiKey)
  return headers
}

async function probeUrl(
  url: string | undefined,
  init: RequestInit | undefined,
  baseFetch: typeof fetch
): Promise<ConnectivityProbeResult | undefined> {
  if (!url) return undefined

  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), CONNECTIVITY_CHECK_TIMEOUT_MS)

  try {
    const response = await baseFetch(url, {
      method: 'GET',
      headers: getAuthHeaders(init),
      cache: 'no-store',
      signal: controller.signal
    })
    return {
      ok: response.ok,
      reachable: true,
      status: response.status,
      durationMs: Date.now() - startedAt
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reachable: false,
      durationMs: Date.now() - startedAt,
      error: message || '连接失败'
    }
  } finally {
    window.clearTimeout(timer)
  }
}

export async function runClientConnectivityCheck(
  input: RequestInfo | URL,
  init?: RequestInit,
  baseFetch: typeof fetch = fetch
): Promise<ClientConnectivityCheck | undefined> {
  const sourceUrl = getFetchUrl(input)
  if (!sourceUrl) return undefined

  const statusUrl = buildConnectivityUrl(sourceUrl, '/api/status')
  const modelsUrl = buildConnectivityUrl(sourceUrl, '/v1/models')
  const [serviceStatus, modelsApi] = await Promise.all([
    probeUrl(statusUrl, init, baseFetch),
    probeUrl(modelsUrl, init, baseFetch)
  ])

  return {
    checkedAt: new Date().toISOString(),
    serviceStatus,
    modelsApi
  }
}

export function diagnoseClientError(error?: SerializedError, options: DiagnoseOptions = {}): ClientErrorDiagnosis {
  const status = readStatus(error)
  const connectivityCheck = readConnectivityCheck(error)
  const msg = normalizeMessage(error)
  const hasStatus = typeof status === 'number'
  const isTimeout = msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout')
  const isFetchFailure =
    msg.includes('failed to fetch') ||
    msg.includes('fetch failed') ||
    msg.includes('networkerror') ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('dns')
  const isProxyOrCert =
    msg.includes('proxy') ||
    msg.includes('socks') ||
    msg.includes('certificate') ||
    msg.includes('self-signed') ||
    msg.includes('unable_to_verify_leaf_signature')
  const isStreamInterrupted =
    msg.includes('context canceled') ||
    msg.includes('client_gone') ||
    msg.includes('econnreset') ||
    msg.includes('connection reset') ||
    msg.includes('stream') ||
    msg.includes('aborted')
  const isParseFailure =
    msg.includes('json') ||
    msg.includes('unexpected token') ||
    msg.includes('invalid response') ||
    msg.includes('parse error')

  const base = {
    httpStatus: hasStatus ? String(status) : '无',
    model: modelLabel(options.model),
    serviceAddress: readUrl(error),
    occurredAt: formatTime(options.createdAt),
    serviceStatusCheck: formatProbeResult(connectivityCheck?.serviceStatus),
    modelApiCheck: formatProbeResult(connectivityCheck?.modelsApi),
    diagnosticId:
      typeof (error as Record<string, unknown> | undefined)?.zenTraceId === 'string'
        ? String((error as Record<string, unknown>).zenTraceId)
        : buildDiagnosticId(options.blockId, options.messageId, options.createdAt)
  }

  if (status === 401 || status === 403) {
    return {
      ...base,
      category: 'account',
      title: '生成失败：账号权限异常',
      summary: '当前账号暂时无法使用该模型。请联系管理员检查账号状态、可用额度或模型权限。',
      stage: '请求校验',
      errorType: '账号权限异常',
      serviceConnectivity: serviceConnectivityFromCheck(connectivityCheck, '已连接'),
      serviceReceived: '是',
      startedGenerating: '否',
      suggestion: '请确认账号状态、可用额度和模型权限；如果刚调整过权限，请稍后重试。'
    }
  }

  if (status === 429) {
    return {
      ...base,
      category: 'rate_limited',
      title: '生成失败：请求过于频繁',
      summary: '当前请求频率较高，请稍后再试。如果持续出现，请联系管理员检查账号限制。',
      stage: '请求校验',
      errorType: '频率限制',
      serviceConnectivity: serviceConnectivityFromCheck(connectivityCheck, '已连接'),
      serviceReceived: '是',
      startedGenerating: '否',
      suggestion: '请等待一小段时间后重试；如果多人同时使用同一账号，请降低并发频率。'
    }
  }

  if (status === 404 || msg.includes('model_not_found') || msg.includes('model not found')) {
    return {
      ...base,
      category: 'model',
      title: '生成失败：模型权限异常',
      summary: '当前账号暂时无法使用所选模型，或模型名称不可用。请联系管理员检查模型权限。',
      stage: '模型校验',
      errorType: '模型不可用',
      serviceConnectivity: serviceConnectivityFromCheck(connectivityCheck, '已连接'),
      serviceReceived: '是',
      startedGenerating: '否',
      suggestion: '请确认所选模型是否仍可使用，必要时切换到其他模型后重试。'
    }
  }

  if (
    msg.includes('context_length_exceeded') ||
    msg.includes('too many tokens') ||
    msg.includes('maximum context length')
  ) {
    return {
      ...base,
      category: 'context',
      title: '生成失败：上下文过长',
      summary: '本次对话或文件内容较长，超过了当前模型可处理的范围。',
      stage: '请求准备',
      errorType: '上下文超限',
      serviceConnectivity: serviceConnectivityFromCheck(connectivityCheck, hasStatus ? '已连接' : UNKNOWN),
      serviceReceived: hasStatus ? '是' : UNKNOWN,
      startedGenerating: '否',
      suggestion: '请减少附件、缩短历史对话，或开启一个新对话后重试。'
    }
  }

  if (status === 413 || msg.includes('payload too large') || msg.includes('request entity too large')) {
    return {
      ...base,
      category: 'payload',
      title: '生成失败：请求内容过大',
      summary: '本次发送的文件或文本内容过大，当前服务未能接收完整请求。',
      stage: '请求上传',
      errorType: '内容过大',
      serviceConnectivity: serviceConnectivityFromCheck(connectivityCheck, '已连接'),
      serviceReceived: '是',
      startedGenerating: '否',
      suggestion: '请压缩或拆分文件，减少一次性发送的内容后重试。'
    }
  }

  if (isTimeout || status === 504) {
    return {
      ...base,
      category: 'timeout',
      title: '生成失败：响应超时',
      summary: '模型服务响应时间较长，请稍后重试，或尝试切换模型。',
      stage: hasStatus ? '等待响应' : '建立连接',
      errorType: '响应超时',
      serviceConnectivity: serviceConnectivityFromCheck(connectivityCheck, hasStatus ? '已连接' : UNKNOWN),
      serviceReceived: hasStatus ? '是' : UNKNOWN,
      startedGenerating: UNKNOWN,
      suggestion: '请重试一次；如果连续出现，可先切换模型或检查当前网络稳定性。'
    }
  }

  if (isFetchFailure || isProxyOrCert) {
    return {
      ...base,
      category: 'network',
      title: '生成失败：连接异常',
      summary: '暂时无法连接到模型服务。请重试一次；如果连续失败，请检查网络、代理或 VPN 设置。',
      stage: '建立连接',
      errorType: isProxyOrCert ? '网络或代理异常' : '连接异常',
      serviceConnectivity: serviceConnectivityFromCheck(connectivityCheck, UNKNOWN),
      serviceReceived: '未确认',
      startedGenerating: '否',
      suggestion: '请先重试；如果仍失败，请检查当前设备网络、代理、VPN 或安全软件拦截。'
    }
  }

  if (status && status >= 500) {
    return {
      ...base,
      category: 'service',
      title: '生成失败：模型服务暂时不可用',
      summary: '模型服务当前响应异常，请稍后重试。',
      stage: '模型服务响应',
      errorType: '服务响应异常',
      serviceConnectivity: serviceConnectivityFromCheck(connectivityCheck, '已连接'),
      serviceReceived: '是',
      startedGenerating: UNKNOWN,
      suggestion: '请稍后重试；如果同一模型连续失败，请联系管理员并提供诊断编号。'
    }
  }

  if (isStreamInterrupted) {
    return {
      ...base,
      category: 'stream',
      title: '生成中断：连接不稳定',
      summary: '回复生成过程中连接中断。通常重试即可恢复；如果连续出现，请检查网络或代理设置。',
      stage: '生成传输',
      errorType: '连接中断',
      serviceConnectivity: serviceConnectivityFromCheck(connectivityCheck, '已连接'),
      serviceReceived: '是',
      startedGenerating: '是',
      suggestion: '请重试一次；如果经常在生成中途失败，请优先检查网络、代理或 VPN 稳定性。'
    }
  }

  if (status === 400 && (msg.includes('content_filter') || msg.includes('safety') || msg.includes('content_policy'))) {
    return {
      ...base,
      category: 'content',
      title: '生成失败：内容无法处理',
      summary: '本次输入内容未能通过模型服务的处理规则。请调整表述后重试。',
      stage: '内容校验',
      errorType: '内容限制',
      serviceConnectivity: serviceConnectivityFromCheck(connectivityCheck, '已连接'),
      serviceReceived: '是',
      startedGenerating: '否',
      suggestion: '请修改敏感、模糊或过于复杂的描述后再试。'
    }
  }

  if (isParseFailure) {
    return {
      ...base,
      category: 'response',
      title: '生成失败：响应处理异常',
      summary: '当前应用未能正确处理本次响应。请重试；如果持续出现，请保存详情并反馈给管理员。',
      stage: '响应处理',
      errorType: '响应格式异常',
      serviceConnectivity: serviceConnectivityFromCheck(connectivityCheck, hasStatus ? '已连接' : UNKNOWN),
      serviceReceived: hasStatus ? '是' : UNKNOWN,
      startedGenerating: UNKNOWN,
      suggestion: '请重试一次；如果持续出现，请提供诊断编号和错误详情。'
    }
  }

  return {
    ...base,
    category: 'unknown',
    title: '生成失败：未知异常',
    summary: '本次请求未能完成。请重试一次；如果持续出现，请保存详情并反馈给管理员。',
    stage: '未确认',
    errorType: error?.name || '未知异常',
    serviceConnectivity: serviceConnectivityFromCheck(connectivityCheck, hasStatus ? '已连接' : UNKNOWN),
    serviceReceived: hasStatus ? '是' : UNKNOWN,
    startedGenerating: UNKNOWN,
    suggestion: '请重试一次；如果连续出现，请提供诊断编号和错误详情。'
  }
}

export function formatClientErrorDiagnosis(diagnosis: ClientErrorDiagnosis): string {
  return [
    '【诊断摘要】',
    `结论：${diagnosis.title}`,
    `说明：${diagnosis.summary}`,
    `发生阶段：${diagnosis.stage}`,
    `错误类型：${diagnosis.errorType}`,
    `HTTP 状态：${diagnosis.httpStatus}`,
    `服务连通性：${diagnosis.serviceConnectivity}`,
    `服务地址检测：${diagnosis.serviceStatusCheck}`,
    `模型接口检测：${diagnosis.modelApiCheck}`,
    `服务是否收到请求：${diagnosis.serviceReceived}`,
    `是否开始生成：${diagnosis.startedGenerating}`,
    `模型：${diagnosis.model}`,
    `服务地址：${diagnosis.serviceAddress}`,
    `发生时间：${diagnosis.occurredAt}`,
    `诊断编号：${diagnosis.diagnosticId}`,
    `建议操作：${diagnosis.suggestion}`
  ].join('\n')
}
