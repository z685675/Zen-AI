import type { AppInfo, Model } from '@renderer/types'
import type { SerializedError } from '@renderer/types/error'
import type { ErrorMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import type { ClientErrorDiagnosis } from '@renderer/utils/clientErrorDiagnosis'
import { formatClientErrorDiagnosis } from '@renderer/utils/clientErrorDiagnosis'
import type { ErrorClassification } from '@renderer/utils/errorClassifier'

export type ErrorDiagnosticSource = 'chat' | 'agent'

export interface ErrorDiagnosticPackageInput {
  source: ErrorDiagnosticSource
  title: string
  description: string
  classification: ErrorClassification
  dependencyIssue?: boolean
  diagnosis: ClientErrorDiagnosis
  error?: SerializedError
  block?: ErrorMessageBlock
  message: Message
  relatedUserMessage?: Message
  blockEntities?: Record<string, MessageBlock | undefined>
  model?: Model
  appInfo?: AppInfo
  sessionContext?: unknown
  aiDiagnosis?: unknown
  privacyNotice: string
}

const SENSITIVE_KEY_PATTERN = /(api[-_]?key|authorization|access[-_]?token|token|secret|password|credential|cookie)/i
const URL_KEY_PATTERN = /(?:^|[-_])(url|uri|endpoint|address)$/i
const MAX_STRING_LENGTH = 4000

const sanitizeUrl = (value: string): string => {
  try {
    const parsed = new URL(value)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return value.split(/[?#]/, 1)[0] || '[INVALID_URL]'
  }
}

const redactString = (value: string, key?: string): string => {
  let redacted = value

  if (URL_KEY_PATTERN.test(key ?? '')) {
    redacted = sanitizeUrl(redacted)
  } else {
    redacted = redacted.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrl(url))
  }

  redacted = redacted
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(
      /((?:api[-_]?key|access[-_]?token|authorization|token|secret|password|credential|cookie)\s*[:=]\s*)(["'])([^"']*)\2/gi,
      '$1[REDACTED]'
    )

  return redacted.length > MAX_STRING_LENGTH ? `${redacted.slice(0, MAX_STRING_LENGTH)}\n...[truncated]` : redacted
}

export const redactDiagnosticValue = (value: unknown, depth = 0, key?: string): unknown => {
  if (depth > 6) return '[Max depth reached]'

  if (typeof value === 'string') {
    return redactString(value, key)
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticValue(item, depth + 1, key))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, item]) => [
        entryKey,
        SENSITIVE_KEY_PATTERN.test(entryKey) ? '[REDACTED]' : redactDiagnosticValue(item, depth + 1, entryKey)
      ])
    )
  }

  return value
}

export const safeDiagnosticJson = (value: unknown): string => {
  try {
    return JSON.stringify(redactDiagnosticValue(value), null, 2)
  } catch {
    return JSON.stringify({ value: String(value) }, null, 2)
  }
}

const formatTimestampForFileName = (date = new Date()): string => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes()
  )}${pad(date.getSeconds())}`
}

const collectMessageBlocks = (
  message: Message | undefined,
  blockEntities: Record<string, MessageBlock | undefined>
): Array<MessageBlock | undefined> => {
  return message?.blocks?.map((blockId) => blockEntities[blockId]) ?? []
}

const getErrorRecord = (error: SerializedError | undefined): Record<string, unknown> => {
  return (error ?? {}) as Record<string, unknown>
}

const getErrorStatus = (error: SerializedError | undefined): number | string | undefined => {
  const record = getErrorRecord(error)
  const status = record.statusCode ?? record.status
  return typeof status === 'number' || typeof status === 'string' ? status : undefined
}

const getErrorUrl = (error: SerializedError | undefined): string | undefined => {
  const record = getErrorRecord(error)
  const url = record.url ?? record.zenRequestUrl
  return typeof url === 'string' && url ? sanitizeUrl(url) : undefined
}

const getTraceId = (error: SerializedError | undefined, message: Message): string | undefined => {
  const errorTraceId = getErrorRecord(error).zenTraceId
  return typeof errorTraceId === 'string' && errorTraceId ? errorTraceId : message.traceId
}

const serializeModel = (model?: Model) => {
  if (!model) return undefined

  return {
    id: model.id,
    provider: model.provider,
    name: model.name,
    group: model.group,
    endpoint_type: model.endpoint_type,
    supported_endpoint_types: model.supported_endpoint_types,
    capabilities: model.capabilities,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    contextCapacitySource: model.contextCapacitySource,
    contextCapacityConfidence: model.contextCapacityConfidence
  }
}

const getRuntimeInfo = () => ({
  platform: navigator.platform,
  language: navigator.language,
  userAgent: navigator.userAgent,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
})

export const exportErrorDiagnosticPackage = async ({
  source,
  title,
  description,
  classification,
  dependencyIssue = false,
  diagnosis,
  error,
  block,
  message,
  relatedUserMessage,
  blockEntities = {},
  model,
  appInfo,
  sessionContext,
  aiDiagnosis,
  privacyNotice
}: ErrorDiagnosticPackageInput): Promise<string> => {
  const exportedAt = new Date().toISOString()
  const packageId = diagnosis.diagnosticId
  const fileName = `zen-ai-${source}-diagnostics-${packageId}-${formatTimestampForFileName()}.zip`
  const assistantBlocks = collectMessageBlocks(message, blockEntities)
  const userBlocks = collectMessageBlocks(relatedUserMessage, blockEntities)
  const errorRecord = getErrorRecord(error)
  const requestContext = {
    traceId: getTraceId(error, message),
    providerId: message.model?.provider ?? errorRecord.providerId,
    modelId: message.model?.id ?? errorRecord.modelId,
    model: serializeModel(model ?? message.model),
    requestUrl: getErrorUrl(error),
    status: getErrorStatus(error),
    connectivityCheck: errorRecord.zenConnectivityCheck
  }

  const summary = {
    schemaVersion: 2,
    packageId,
    source,
    exportedAt,
    occurredAt: diagnosis.occurredAt,
    issue: {
      title,
      description,
      category: classification.category,
      dependencyIssue,
      navTarget: classification.navTarget
    },
    request: requestContext,
    app: appInfo,
    runtime: getRuntimeInfo()
  }

  const messageContext = {
    topicId: message.topicId,
    messageId: message.id,
    blockId: block?.id ?? message.blocks.find((blockId) => blockEntities[blockId]?.type === 'error'),
    assistantMessage: message,
    userMessage: relatedUserMessage,
    assistantBlocks,
    userBlocks
  }

  const files: Array<{ path: string; content: string }> = [
    {
      path: 'README.txt',
      content: [
        'Zen AI 错误诊断包',
        '',
        'summary.json：问题摘要、应用版本、运行环境和请求概要。',
        'diagnosis.json / diagnosis.txt：应用生成的结构化诊断结果。',
        'error.json：经过脱敏处理的原始错误信息。',
        'request.json：模型、服务地址、状态码和连通性信息。',
        'message-context.json：出错消息及相关上下文，可能包含用户输入内容。',
        'environment.json：导出时的环境信息。',
        ...(sessionContext !== undefined ? ['session-context.json：智能助手会话配置。'] : []),
        ...(aiDiagnosis !== undefined ? ['ai-diagnosis.json：已生成的 AI 诊断结果。'] : []),
        '',
        privacyNotice
      ].join('\n')
    },
    { path: 'summary.json', content: safeDiagnosticJson(summary) },
    { path: 'privacy.txt', content: privacyNotice },
    { path: 'diagnosis.txt', content: formatClientErrorDiagnosis(diagnosis) },
    { path: 'diagnosis.json', content: safeDiagnosticJson(diagnosis) },
    { path: 'error.json', content: safeDiagnosticJson(error ?? {}) },
    { path: 'request.json', content: safeDiagnosticJson(requestContext) },
    { path: 'message-context.json', content: safeDiagnosticJson(messageContext) },
    {
      path: 'environment.json',
      content: safeDiagnosticJson({ appInfo, ...getRuntimeInfo(), exportedAt })
    }
  ]

  if (sessionContext !== undefined) {
    files.push({ path: 'session-context.json', content: safeDiagnosticJson(sessionContext) })
  }

  if (aiDiagnosis !== undefined) {
    files.push({ path: 'ai-diagnosis.json', content: safeDiagnosticJson(aiDiagnosis) })
  }

  return await window.api.file.saveDiagnosticPackage(fileName, files)
}
