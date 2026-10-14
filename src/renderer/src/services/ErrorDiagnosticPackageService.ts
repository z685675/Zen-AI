import i18n from '@renderer/i18n'
import type { AppInfo, Model } from '@renderer/types'
import type { SerializedError } from '@renderer/types/error'
import type { ErrorMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import type { ClientErrorDiagnosis } from '@renderer/utils/clientErrorDiagnosis'
import { formatClientErrorDiagnosis } from '@renderer/utils/clientErrorDiagnosis'
import { createZenTraceId } from '@renderer/utils/clientErrorDiagnosis'
import type { ErrorClassification } from '@renderer/utils/errorClassifier'
import { attributeDiagnostic, type DiagnosticEvent, diagnosticText, sanitizeDiagnostic } from '@shared/diagnostics'

import { getContextTelemetry } from './context/ContextTelemetryService'
import { collectBackendDiagnostic } from './DiagnosticBackendService'
import { getDiagnosticEvidence } from './DiagnosticEvidenceService'

const t = i18n.t

export type ErrorDiagnosticSource = 'chat' | 'agent'

export async function getDiagnosticAppInfo(): Promise<AppInfo | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      window.api.getAppInfo().catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 3000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export interface ErrorDiagnosticPackageInput {
  source: ErrorDiagnosticSource
  title: string
  description: string
  classification?: ErrorClassification
  dependencyIssue?: boolean
  diagnosis?: ClientErrorDiagnosis
  snapshotHasMessage?: boolean
  error?: SerializedError
  block?: ErrorMessageBlock
  message: Message
  relatedUserMessage?: Message
  blockEntities?: Record<string, MessageBlock | undefined>
  model?: Model
  appInfo?: AppInfo
  sessionContext?: unknown
  sessionContextStatus?: string
  aiDiagnosis?: unknown
  privacyNotice: string
}

const sanitizeUrl = (value: string): string => {
  try {
    const parsed = new URL(value)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return value.split(/[?#]/, 1)[0] || '[INVALID_URL]'
  }
}

export const redactDiagnosticValue = (value: unknown): unknown => sanitizeDiagnostic(value)

export const safeDiagnosticJson = (value: unknown): string => {
  try {
    return JSON.stringify(redactDiagnosticValue(value), null, 2)
  } catch {
    return JSON.stringify({ value: diagnosticText(String(value)), serializationFailed: true }, null, 2)
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
  snapshotHasMessage = true,
  error,
  block,
  message,
  relatedUserMessage,
  blockEntities = {},
  model,
  appInfo,
  sessionContext,
  sessionContextStatus,
  aiDiagnosis,
  privacyNotice
}: ErrorDiagnosticPackageInput): Promise<string> => {
  const mode = diagnosis ? 'error' : 'snapshot'
  const observedStatus = snapshotHasMessage
    ? message.status
    : relatedUserMessage
      ? 'no-assistant-record-yet'
      : 'no-recorded-turn'
  const exportedAt = new Date().toISOString()
  const packageId = diagnosis?.diagnosticId ?? createZenTraceId()
  const fileName = `zen-ai-${source}-diagnostics-${packageId}-${formatTimestampForFileName()}.zip`
  const assistantBlocks = collectMessageBlocks(message, blockEntities)
  const userBlocks = collectMessageBlocks(relatedUserMessage, blockEntities)
  const errorRecord = getErrorRecord(error)
  const rendererEvidence = getDiagnosticEvidence(message.id)
  const operationId = String(rendererEvidence?.metadata.runtimeOperationId ?? errorRecord.zenDiagnosticId ?? message.id)
  let mainStatus = 'unavailable'
  let mainEvidence: Awaited<ReturnType<typeof window.api.file.collectDiagnosticEvidence>> | undefined
  let collectionTimer: ReturnType<typeof setTimeout> | undefined
  try {
    mainEvidence = await Promise.race([
      window.api.file.collectDiagnosticEvidence(operationId),
      new Promise<never>((_, reject) => {
        collectionTimer = setTimeout(() => reject(new Error('collection timeout')), 3_000)
      })
    ])
    mainStatus = mainEvidence?.snapshotStatus ?? 'unavailable'
  } catch (collectionError) {
    mainStatus = collectionError instanceof Error ? collectionError.message : 'collection-failed'
  } finally {
    clearTimeout(collectionTimer)
  }
  const events: DiagnosticEvent[] = [
    ...(rendererEvidence?.events ?? []),
    ...(mainEvidence?.evidence?.events ?? [])
  ].sort((a, b) => a.at.localeCompare(b.at))
  const { default: store } = await import('@renderer/store')
  const provider = store.getState().llm.providers.find((candidate) => candidate.id === message.model?.provider)
  const backend = await collectBackendDiagnostic(operationId, provider, events)
  const attribution = attributeDiagnostic(events, backend.evidence)
  const opencodeEvents = events.filter((event) => event.stage === 'runtime' && event.details?.runtime === 'opencode')
  const processEvents = opencodeEvents.filter((event) =>
    [
      'startup-stage',
      'process-spawned',
      'process-health',
      'process-error',
      'process-exit',
      'process-close',
      'process-snapshot'
    ].includes(event.event)
  )
  const opencodeStatus = opencodeEvents.length ? 'observed-current-operation' : 'no-operation-runtime-evidence'
  const collections = {
    renderer: rendererEvidence ? 'collected' : 'unavailable-old-request-or-expired',
    main: mainStatus,
    logs: mainEvidence?.logStatus ?? 'unavailable',
    zenApi: backend.status,
    opencode: source === 'agent' ? opencodeStatus : 'not-applicable',
    session:
      sessionContextStatus ??
      (sessionContext !== undefined
        ? 'collected-at-export-time'
        : source === 'agent'
          ? 'unavailable-or-timed-out'
          : 'not-applicable'),
    appInfo: appInfo ? 'collected' : 'unavailable',
    userMessage: relatedUserMessage ? 'collected' : 'not-loaded-or-unavailable',
    blocks: [
      ...collectMessageBlocks(message, blockEntities),
      ...collectMessageBlocks(relatedUserMessage, blockEntities)
    ].some((block) => block === undefined)
      ? 'partially-not-loaded'
      : 'collected'
  }
  const requestContext = {
    traceId: getTraceId(error, message),
    operationId,
    transportTraceIds: [...new Set(events.map((event) => event.details?.traceId).filter(Boolean))],
    gatewayRequestIds: [...new Set(events.map((event) => event.details?.requestId).filter(Boolean))],
    providerId: message.model?.provider ?? errorRecord.providerId,
    modelId: message.model?.id ?? errorRecord.modelId,
    model: serializeModel(model ?? message.model),
    requestUrl: getErrorUrl(error),
    status: getErrorStatus(error),
    connectivityCheck: errorRecord.zenConnectivityCheck
  }

  const summary = {
    schemaVersion: 3,
    packageId,
    source,
    exportedAt,
    mode,
    occurredAt: diagnosis?.occurredAt,
    observation: {
      messageStatus: observedStatus,
      responseOutcome: message.providerMetadata?.responseTiming?.outcome,
      observedAt: exportedAt,
      automaticReplay: false
    },
    attribution,
    collections,
    issue: {
      title,
      description,
      category: classification?.category,
      dependencyIssue,
      navTarget: classification?.navTarget
    },
    request: requestContext,
    app: appInfo,
    runtime: getRuntimeInfo()
  }

  const messageContext = {
    topicId: message.topicId,
    messageId: message.id,
    blockId: block?.id ?? message.blocks.find((blockId) => blockEntities[blockId]?.type === 'error'),
    assistantMessage: snapshotHasMessage ? message : undefined,
    userMessage: relatedUserMessage,
    assistantBlocks,
    userBlocks
  }

  const files: Array<{ path: string; content: string }> = [
    {
      path: 'README.txt',
      content: [
        mode === 'error' ? 'Zen AI 错误诊断包' : 'Zen AI 当前会话诊断快照（不代表任务失败）',
        '',
        'summary.json：问题摘要、应用版本、运行环境和请求概要。',
        ...(diagnosis
          ? ['diagnosis.json / diagnosis.txt：应用生成的结构化错误诊断结果。']
          : ['task-status.json：导出时的任务状态观察，不代表任务失败。']),
        'error.json：经过脱敏处理的原始错误信息。',
        'request.json：模型、服务地址、状态码和连通性信息。',
        'message-context.json：出错消息及相关上下文，可能包含用户输入内容。',
        'environment.json：导出时的环境信息。',
        ...(source === 'agent'
          ? ['opencode-runtime.json：本轮新版内核启动/退出、限量脱敏标准错误和导出时执行文件检查；没有采到时明确标注。']
          : []),
        '链路结论.txt / attribution.json：基于实测事件的故障位置及证据，不足时明确标注未确认。',
        'timeline.json：本地处理、底座、HTTP 请求和响应全过程，包含自动重试。',
        'zen-api-evidence.json：Zen API 接收、渠道尝试和返回证据（只读查询，不会调用模型）。',
        'collection-manifest.json：缺失、超时及有界截断说明；integrity.json：ZIP 文件校验。',
        ...(sessionContext !== undefined ? ['session-context.json：智能助手会话配置。'] : []),
        ...(aiDiagnosis !== undefined ? ['ai-diagnosis.json：已生成的 AI 诊断结果。'] : []),
        '',
        privacyNotice
      ].join('\n')
    },
    { path: 'summary.json', content: safeDiagnosticJson(summary) },
    { path: 'privacy.txt', content: privacyNotice },
    ...(diagnosis
      ? [
          {
            path: 'diagnosis.txt',
            content: diagnosticText(
              `说明：以下是按错误信息生成的初步分类，实际链路定位以“链路结论.txt”为准。\n\n${formatClientErrorDiagnosis(diagnosis)}`
            )
          },
          { path: 'diagnosis.json', content: safeDiagnosticJson(diagnosis) }
        ]
      : [
          {
            path: 'task-status.json',
            content: safeDiagnosticJson({
              mode,
              status: observedStatus,
              responseOutcome: message.providerMetadata?.responseTiming?.outcome,
              observedAt: exportedAt,
              automaticReplay: false
            })
          }
        ]),
    { path: 'error.json', content: safeDiagnosticJson(error ?? {}) },
    { path: 'request.json', content: safeDiagnosticJson(requestContext) },
    { path: 'message-context.json', content: safeDiagnosticJson(messageContext) },
    {
      path: 'environment.json',
      content: safeDiagnosticJson({ appInfo, ...getRuntimeInfo(), exportedAt })
    },
    {
      path: '链路结论.txt',
      content: diagnosticText(
        [
          t(mode === 'error' ? 'error.diagnosis.chain_error_line' : 'error.diagnosis.chain_observation_line', {
            owner: {
              'zen-ai': 'Zen AI 客户端',
              'zen-api': 'Zen API 网关或上游渠道',
              'network-or-proxy': '连接链路（责任端未确认）',
              undetermined: '未确认'
            }[attribution.owner]
          }),
          `判断程度：${{ confirmed: '已确认发生位置，不等于已经确定根因', suspected: '疑似', insufficient: '证据不足' }[attribution.confidence]}`,
          `环节：${attribution.stage}`,
          `说明：${attribution.explanation}`,
          `后台证据：${backend.status}`,
          '注意：未查到后台记录不能证明请求未到达；诊断包仍可能包含本次用户输入。',
          ...attribution.evidence
        ].join('\n')
      )
    },
    { path: 'attribution.json', content: safeDiagnosticJson(attribution) },
    {
      path: 'timeline.json',
      content: safeDiagnosticJson({
        operationId,
        messageId: message.id,
        renderer: rendererEvidence,
        main: mainEvidence?.evidence,
        events
      })
    },
    { path: 'zen-api-evidence.json', content: safeDiagnosticJson(backend) },
    {
      path: 'runtime-environment.json',
      content: safeDiagnosticJson(mainEvidence?.environment ?? { unavailable: true })
    },
    { path: 'operation-logs.json', content: safeDiagnosticJson(mainEvidence?.logs ?? []) },
    {
      path: 'context-processing.json',
      content: safeDiagnosticJson({
        failureTimeEvidence: events.filter((event) => event.stage === 'context'),
        currentAtExportTime: getContextTelemetry(message.topicId)
      })
    },
    {
      path: 'collection-manifest.json',
      content: safeDiagnosticJson({
        collections,
        limits: {
          eventsPerProcess: 160,
          retainedOperations: 100,
          textCharacters: 8000,
          longText: 'head-and-tail',
          logs: 'operation-matched-last-80'
        },
        droppedEvents: (rendererEvidence?.droppedEvents ?? 0) + (mainEvidence?.evidence?.droppedEvents ?? 0),
        contentPolicy: '不包含附件原件和完整历史；出错消息及相关用户消息可能包含个人信息。'
      })
    }
  ]

  if (source === 'agent') {
    files.push({
      path: 'opencode-runtime.json',
      content: safeDiagnosticJson({
        schemaVersion: 1,
        operationId,
        status: opencodeStatus,
        events: processEvents,
        failureEvents: opencodeEvents.filter((event) => event.event === 'failed'),
        environmentAtExportTime: {
          executable: mainEvidence?.environment?.executables?.opencode,
          packageVersion: mainEvidence?.environment?.componentVersions?.['opencode-ai'],
          snapshotTime: 'export-time'
        },
        notes: [
          '本轮观测与导出时文件状态分开；expectedVersion不是实际运行版本，以process-health为准。',
          '标准错误按本轮观察窗口采集，有界脱敏；无输出不代表无故障，未包含完整配置、环境变量或标准输出。',
          '用户停止、超时终止与空闲回收不等于内核异常退出。旧请求或软件直接崩溃可能缺失进程证据。'
        ]
      })
    })
  }

  if (sessionContext !== undefined) {
    files.push({ path: 'session-context.json', content: safeDiagnosticJson(sessionContext) })
  }

  if (aiDiagnosis !== undefined) {
    files.push({ path: 'ai-diagnosis.json', content: safeDiagnosticJson(aiDiagnosis) })
  }

  return await window.api.file.saveDiagnosticPackage(fileName, files)
}
