import { loggerService } from '@logger'
import type { McpError } from '@modelcontextprotocol/sdk/types.js'
import type { AgentServerError } from '@renderer/types'
import { AgentServerErrorSchema } from '@renderer/types'
import type {
  AiSdkErrorUnion,
  SerializedAiSdkError,
  SerializedAiSdkInvalidToolInputError,
  SerializedAiSdkNoSuchToolError,
  SerializedError
} from '@renderer/types/error'
import { isSerializedAiSdkAPICallError } from '@renderer/types/error'
import { safeSerialize } from '@shared/utils/serialize'
import type { NoSuchToolError } from 'ai'
import { AISDKError } from 'ai'
import { InvalidToolInputError } from 'ai'
import type { AxiosError } from 'axios'
import { isAxiosError } from 'axios'
import { t } from 'i18next'
import type * as z from 'zod'
import { ZodError } from 'zod'

import { ZEN_TRACE_HEADER } from './clientErrorDiagnosis'
import { parseJSON } from './json'

const logger = loggerService.withContext('Utils:error')

export function getErrorDetails(err: any, seen = new WeakSet()): any {
  // Handle circular references
  if (err === null || typeof err !== 'object' || seen.has(err)) {
    return err
  }

  seen.add(err)
  const result: any = {}

  // Get all enumerable properties, including those from the prototype chain
  const allProps = new Set([...Object.getOwnPropertyNames(err), ...Object.keys(err)])

  for (const prop of allProps) {
    try {
      const value = err[prop]
      // Skip function properties
      if (typeof value === 'function') continue
      // Recursively process nested objects
      result[prop] = getErrorDetails(value, seen)
    } catch (e) {
      result[prop] = '<Unable to access property>'
    }
  }

  return result
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return formatZodError(error)
  }
  if (isAxiosError(error)) {
    return formatAxiosError(error)
  }
  const parseResult = AgentServerErrorSchema.safeParse(error)
  if (parseResult.success) {
    return formatAgentServerError(parseResult.data)
  }
  const detailedError = getErrorDetails(error)
  delete detailedError?.headers
  delete detailedError?.stack
  delete detailedError?.request_id

  if (detailedError) {
    const formattedJson = JSON.stringify(detailedError, null, 2)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
    return detailedError.message ? detailedError.message : `Error Details:\n${formattedJson}`
  } else {
    logger.warn('Get detailed error failed.')
    return ''
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  } else {
    return t('error.unknown')
  }
}

export function formatErrorMessageWithPrefix(error: unknown, prefix: string): string {
  const msg = getErrorMessage(error)
  return `${prefix}: ${msg}`
}

export const isTimeoutError = (error: any): boolean => {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return true
  }

  const cause = error?.cause
  if (cause instanceof DOMException && cause.name === 'TimeoutError') {
    return true
  }

  return false
}

export const isAbortError = (error: any): boolean => {
  // Timeout errors should not be treated as user-initiated aborts
  if (isTimeoutError(error)) {
    return false
  }

  // Convert message to string for consistent checking
  const errorMessage = String(error?.message || '')

  // 检查错误消息
  if (errorMessage === 'Request was aborted.') {
    return true
  }

  // 检查是否为 DOMException 类型的中止错误
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true
  }

  // 检查 OpenAI 特定的错误结构
  if (
    error &&
    typeof error === 'object' &&
    errorMessage &&
    (errorMessage === 'Request was aborted.' || errorMessage.includes('signal is aborted without reason'))
  ) {
    return true
  }

  return false
}

// TODO: format
export const formatMcpError = (error: McpError) => {
  return error.message
}

const getBaseError = (error: Error) => {
  return {
    name: error.name ?? null,
    message: error.message ?? null,
    stack: error.stack ?? null,
    cause: error.cause ? String(error.cause) : null
  } as const
}

const serializeInvalidToolInputError = (error: InvalidToolInputError): SerializedAiSdkInvalidToolInputError => {
  const baseError = getBaseError(error)
  return {
    ...baseError,
    toolName: error.toolName,
    toolInput: error.toolInput
  } satisfies SerializedAiSdkInvalidToolInputError
}

const serializeNoSuchToolError = (error: NoSuchToolError): SerializedAiSdkNoSuchToolError => {
  const baseError = getBaseError(error)
  return {
    ...baseError,
    toolName: error.toolName ?? null,
    availableTools: error.availableTools ?? null
  } satisfies SerializedAiSdkNoSuchToolError
}

export const serializeError = (error: AiSdkErrorUnion): SerializedError => {
  // 统一所有可能的错误字段
  const serializedError: SerializedError = {
    name: error.name ?? null,
    message: error.message ?? null,
    stack: error.stack ?? null,
    cause: safeSerialize(error.cause)
  }

  if ('url' in error) serializedError.url = error.url
  if ('requestBodyValues' in error) serializedError.requestBodyValues = safeSerialize(error.requestBodyValues)
  if ('statusCode' in error) serializedError.statusCode = error.statusCode ?? null
  if ('responseBody' in error && error.responseBody) {
    const body = parseJSON(error.responseBody)
    if (body) {
      // try to parse internal msg
      const message = body.message || body.msg
      if (message) {
        if (serializedError.message === null) {
          serializedError.message = message
        } else {
          serializedError.message += ' ' + message
        }
      }
      serializedError.responseBody = JSON.stringify(body, null, 2)
    } else {
      serializedError.responseBody = error.responseBody
    }
  }
  if ('isRetryable' in error) serializedError.isRetryable = error.isRetryable
  if ('data' in error) serializedError.data = safeSerialize(error.data)
  if ('responseHeaders' in error) serializedError.responseHeaders = error.responseHeaders ?? null
  if ('statusText' in error) serializedError.statusText = error.statusText ?? null
  if ('parameter' in error) serializedError.parameter = error.parameter
  if ('value' in error) serializedError.value = safeSerialize(error.value)
  if ('content' in error) serializedError.content = safeSerialize(error.content)
  if ('role' in error) serializedError.role = error.role
  if ('prompt' in error) serializedError.prompt = safeSerialize(error.prompt)
  if ('toolName' in error) serializedError.toolName = error.toolName
  if ('toolInput' in error) serializedError.toolInput = error.toolInput
  if ('text' in error) serializedError.text = error.text ?? null
  if ('originalMessage' in error) serializedError.originalMessage = safeSerialize(error.originalMessage)
  if ('response' in error) serializedError.response = safeSerialize(error.response)
  if ('usage' in error) serializedError.usage = safeSerialize(error.usage)
  if ('finishReason' in error) serializedError.finishReason = error.finishReason ?? null
  if ('modelId' in error) serializedError.modelId = error.modelId
  if ('modelType' in error) serializedError.modelType = error.modelType
  if ('providerId' in error) serializedError.providerId = error.providerId
  if ('availableProviders' in error) serializedError.availableProviders = error.availableProviders
  if ('availableTools' in error) serializedError.availableTools = error.availableTools ?? null
  if ('reason' in error) serializedError.reason = error.reason
  if ('lastError' in error) serializedError.lastError = safeSerialize(error.lastError)
  if ('errors' in error) serializedError.errors = error.errors.map((err: unknown) => safeSerialize(err))
  if ('originalError' in error)
    serializedError.originalError = InvalidToolInputError.isInstance(error.originalError)
      ? serializeInvalidToolInputError(error.originalError)
      : serializeNoSuchToolError(error.originalError)
  if ('functionality' in error) serializedError.functionality = error.functionality
  if ('provider' in error) serializedError.provider = error.provider
  if ('zenTraceId' in error && typeof error.zenTraceId === 'string') {
    serializedError.zenTraceId = error.zenTraceId
  }
  if ('zenRequestUrl' in error && typeof error.zenRequestUrl === 'string') {
    serializedError.zenRequestUrl = error.zenRequestUrl
  }
  if ('zenConnectivityCheck' in error && error.zenConnectivityCheck) {
    const serialized = safeSerialize(error.zenConnectivityCheck, { pretty: false })
    if (serialized) {
      serializedError.zenConnectivityCheck = JSON.parse(serialized)
    }
  }
  if (
    !serializedError.zenTraceId &&
    serializedError.responseHeaders &&
    typeof serializedError.responseHeaders === 'object'
  ) {
    const headers = serializedError.responseHeaders as Record<string, string>
    serializedError.zenTraceId = headers[ZEN_TRACE_HEADER] || headers[ZEN_TRACE_HEADER.toLowerCase()]
  }

  return serializedError
}
/**
 * 格式化 Zod 验证错误信息为可读的字符串
 * @param error - Zod 验证错误对象
 * @param title - 可选的错误标题，会作为前缀添加到错误信息中
 * @returns 格式化后的错误信息字符串。
 */
export const formatZodError = (error: z.ZodError, title?: string) => {
  const readableErrors = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
  const errorMessage = readableErrors.join('\n')
  return title ? `${title}: \n${errorMessage}` : errorMessage
}

/**
 * 将任意值安全地转换为字符串
 * @param value - 需要转换的值，unknown 类型
 * @returns 转换后的字符串
 *
 * @description
 * 该函数可以安全地处理以下情况:
 * - null 和 undefined 会被转换为 'null'
 * - 字符串直接返回
 * - 原始类型(数字、布尔值、bigint等)使用 String() 转换
 * - 对象和数组会尝试使用 JSON.stringify 序列化，并处理循环引用
 * - 如果序列化失败，返回错误信息
 *
 * @example
 * ```ts
 * safeToString(null)  // 'null'
 * safeToString('test')  // 'test'
 * safeToString(123)  // '123'
 * safeToString({a: 1})  // '{"a":1}'
 * ```
 */
export function safeToString(value: unknown): string {
  // 处理 null 和 undefined
  if (value == null) {
    return 'null'
  }

  // 字符串直接返回
  if (typeof value === 'string') {
    return value
  }

  // 数字、布尔值、bigint 等原始类型，安全用 String()
  if (typeof value !== 'object' && typeof value !== 'function') {
    return String(value)
  }

  // 处理对象（包括数组）
  if (typeof value === 'object') {
    // 处理函数
    if (typeof value === 'function') {
      return value.toString()
    }
    // 其他对象
    try {
      return JSON.stringify(value, getCircularReplacer())
    } catch (err) {
      return '[Unserializable: ' + err + ']'
    }
  }

  return String(value)
}

// 防止循环引用导致的 JSON.stringify 崩溃
function getCircularReplacer() {
  const seen = new WeakSet()
  return (_key: string, value: unknown) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]'
      }
      seen.add(value)
    }
    return value
  }
}

export function formatError(error: SerializedError): string {
  return `${t('error.name')}: ${error.name}\n${t('error.message')}: ${error.message}\n${t('error.stack')}: ${error.stack}`
}

const CLIPBOARD_FIELD_MAX_LENGTH = 400
const CLIPBOARD_TOTAL_MAX_LENGTH = 3000

function truncateClipboardValue(value: string, maxLength = CLIPBOARD_FIELD_MAX_LENGTH): string {
  const normalized = value.replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return ''
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, maxLength)}… [已截断，共 ${normalized.length} 个字符]`
}

function summarizeClipboardValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return undefined
    }

    const parsed = parseJSON(trimmed)
    if (parsed && parsed !== value) {
      const parsedSummary = summarizeClipboardValue(parsed)
      if (parsedSummary) {
        return parsedSummary
      }
    }

    return truncateClipboardValue(trimmed)
  }

  if (typeof value !== 'object') {
    return truncateClipboardValue(safeToString(value))
  }

  if (Array.isArray(value)) {
    const summary = value
      .map((item) => summarizeClipboardValue(item))
      .filter(Boolean)
      .join('; ')
    return summary ? truncateClipboardValue(summary) : undefined
  }

  const record = value as Record<string, unknown>
  const nestedError =
    typeof record.error === 'object' && record.error !== null && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : undefined
  const candidates = [nestedError, record].filter(Boolean) as Record<string, unknown>[]
  const knownKeys = ['message', 'msg', 'detail', 'error_description', 'type', 'code', 'param', 'status', 'statusCode']

  for (const candidate of candidates) {
    const parts = knownKeys
      .map((key) => {
        const candidateValue = candidate[key]
        if (candidateValue === null || candidateValue === undefined || candidateValue === '') {
          return null
        }
        return `${key}: ${safeToString(candidateValue)}`
      })
      .filter(Boolean)

    if (parts.length > 0) {
      return truncateClipboardValue(parts.join('; '))
    }
  }

  return truncateClipboardValue(safeToString(record))
}

export function formatErrorForClipboard(error: SerializedError): string {
  const lines = ['【技术摘要】']
  const pushLine = (label: string, value: unknown) => {
    const summary = summarizeClipboardValue(value)
    if (summary) {
      lines.push(`${label}: ${summary}`)
    }
  }

  pushLine('错误类型', error.name)
  pushLine('错误消息', error.message)
  pushLine('原因', 'cause' in error ? error.cause : undefined)
  pushLine('状态码', 'statusCode' in error ? error.statusCode : 'status' in error ? error.status : undefined)
  pushLine('状态文本', 'statusText' in error ? error.statusText : undefined)
  pushLine('Provider', error.providerId)
  pushLine('模型', error.modelId)
  pushLine('Trace ID', error.zenTraceId)
  pushLine('请求地址', error.zenRequestUrl || ('url' in error ? error.url : undefined))

  const serviceResponseSummary =
    summarizeClipboardValue('responseBody' in error ? error.responseBody : undefined) ||
    summarizeClipboardValue('data' in error ? error.data : undefined) ||
    summarizeClipboardValue('response' in error ? error.response : undefined) ||
    summarizeClipboardValue('lastError' in error ? error.lastError : undefined) ||
    summarizeClipboardValue('errors' in error ? error.errors : undefined)

  if (serviceResponseSummary) {
    lines.push(`服务返回: ${serviceResponseSummary}`)
  }

  const text = lines.join('\n')
  if (text.length <= CLIPBOARD_TOTAL_MAX_LENGTH) {
    return text
  }

  return `${text.slice(0, CLIPBOARD_TOTAL_MAX_LENGTH)}\n… [技术摘要已截断，共 ${text.length} 个字符]`
}

export function formatAiSdkError(error: SerializedAiSdkError): string {
  let text = formatError(error) + '\n'
  if (error.cause) {
    text += `${t('error.cause')}: ${error.cause}\n`
  }
  if (isSerializedAiSdkAPICallError(error)) {
    if (error.statusCode) {
      text += `${t('error.statusCode')}: ${error.statusCode}\n`
    }
    text += `${t('error.requestUrl')}: ${error.url}\n`
    const requestBodyValues = safeToString(error.requestBodyValues)
    text += `${t('error.requestBodyValues')}: ${requestBodyValues}\n`
    if (error.responseHeaders) {
      text += `${t('error.responseHeaders')}: ${JSON.stringify(error.responseHeaders, null, 2)}\n`
    }
    if (error.responseBody) {
      text += `${t('error.responseBody')}: ${error.responseBody}\n`
    }
    if (error.data) {
      const data = safeToString(error.data)
      text += `${t('error.data')}: ${data}\n`
    }
  }

  return text.trim()
}
const agentErrorCodeLabels: Record<string, string> = {
  task_creation_failed: '定时任务创建失败',
  task_list_failed: '定时任务加载失败',
  task_get_failed: '定时任务读取失败',
  task_update_failed: '定时任务更新失败',
  task_delete_failed: '定时任务删除失败',
  task_run_failed: '定时任务执行失败',
  task_logs_failed: '定时任务运行历史加载失败'
}

export const formatAgentServerError = (error: AgentServerError) => {
  const label = agentErrorCodeLabels[error.error.code]
  return label ? `${label}: ${error.error.message}` : `${t('common.error')}: ${error.error.code} ${error.error.message}`
}
export const formatAxiosError = (error: AxiosError) => {
  if (!error.response) {
    return `${t('common.error')}: ${t('error.no_response')}`
  }

  const { status, statusText } = error.response

  return `${t('common.error')}: ${status} ${statusText}`
}

/**
 * Safely serialize an unknown error to SerializedError format.
 * Used specifically for health check error handling.
 */
export function serializeHealthCheckError(error: unknown): SerializedError {
  if (AISDKError.isInstance(error)) {
    return serializeError(error)
  }
  return {
    name: null,
    message: safeToString(error),
    stack: null
  }
}
