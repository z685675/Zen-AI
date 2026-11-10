import type { DiagnosticEvent, DiagnosticEvidence } from './diagnostics'
import { serverAttemptTiming } from './serverTiming'

type Details = Record<string, unknown>
const details = (event: DiagnosticEvent): Details => event.details ?? {}

/** Compare call IDs in one turn. Repeated names and MCP JSON-RPC IDs do not
 * establish native call identity. Unknown observations remain unknown. */
export function buildToolArgumentReport(
  events: DiagnosticEvent[],
  backend: Array<Record<string, unknown>> = [],
  droppedEvents = 0,
  retention?: DiagnosticEvidence['retention']
) {
  const config = events.findLast((event) => event.event === 'transport-config' && event.details?.runtime === 'opencode')
  const observations = events.filter((event) => event.event === 'tool-arguments').map(details)
  const wire = observations.filter((entry) => entry.phase === 'provider-wire')
  const native = observations.filter((entry) => entry.phase === 'native-decoded')
  const execution = observations.filter((entry) => entry.phase === 'mcp-execution')
  const serverCalls = backend.flatMap((entry) =>
    (Array.isArray(entry.attempts) ? entry.attempts : []).flatMap((attempt) => {
      const timing = serverAttemptTiming(attempt?.timing)
      const rows = timing?.toolArguments ?? []
      return rows
        .filter((row) => row.source === 'upstream-raw')
        .map((raw) => {
          const forwards = rows.filter(
            (row) => row.source === 'client-forward' && raw.callId && row.callId === raw.callId && row.tool === raw.tool
          )
          const forward = forwards.length === 1 ? forwards[0] : undefined
          return {
            requestId: entry.requestId,
            channelId: attempt.channelId,
            nativeToolCallId: raw.callId,
            toolName: raw.tool,
            raw,
            forward,
            finding:
              raw.complete && forward?.complete && raw.fingerprint && forward.fingerprint
                ? raw.fingerprint === forward.fingerprint
                  ? 'api-boundaries-consistent'
                  : 'changed-inside-api'
                : 'insufficient'
          }
        })
    })
  )
  const calls = wire.map((entry) => {
    const matches = native.filter(
      (item) =>
        entry.nativeToolCallId && item.nativeToolCallId === entry.nativeToolCallId && item.toolName === entry.toolName
    )
    const decoded = matches.length === 1 ? matches[0] : undefined
    const executions = decoded?.argumentFingerprint
      ? execution.filter(
          (item) => item.toolName === decoded.toolName && item.argumentFingerprint === decoded.argumentFingerprint
        )
      : []
    const sameInputs = decoded
      ? native.filter(
          (item) => item.toolName === decoded.toolName && item.argumentFingerprint === decoded.argumentFingerprint
        ).length
      : 0
    const executed = executions.length === 1 && sameInputs === 1 ? executions[0] : undefined
    let finding = 'insufficient'
    if (entry.argumentComplete === true) {
      if (entry.snapshotMatches === false) finding = 'wire-protocol-conflict'
      else if (Number(entry.missingRequiredKeys) > 0) finding = 'missing-at-provider-boundary'
      else if (
        decoded &&
        entry.argumentFingerprint &&
        decoded.argumentFingerprint &&
        entry.argumentFingerprint !== decoded.argumentFingerprint
      )
        finding = 'changed-before-native-execution'
      else if (entry.argumentFingerprint && entry.argumentFingerprint === decoded?.argumentFingerprint)
        finding = 'wire-and-native-consistent'
    }
    return {
      nativeToolCallId: entry.nativeToolCallId,
      toolName: entry.toolName,
      transportRequestId: entry.transportRequestId,
      requestId: entry.requestId,
      server: serverCalls.filter(
        (row) =>
          row.requestId === entry.requestId &&
          row.nativeToolCallId === entry.nativeToolCallId &&
          row.toolName === entry.toolName
      ),
      finding,
      wire: entry,
      native: decoded,
      execution: executed,
      executionCorrelation: executed
        ? 'unique-name-and-fingerprint'
        : executions.length > 0
          ? 'ambiguous-identical-inputs'
          : String(entry.toolName).startsWith('mcp__')
            ? 'unconfirmed'
            : 'not-mcp',
      nativeCorrelation: matches.length === 1 ? 'call-id' : matches.length ? 'ambiguous-call-id' : 'unobserved'
    }
  })
  return {
    version: 1,
    runtimeCapabilities: {
      toolArgumentAuditVersion: config?.details?.toolArgumentAuditVersion ?? null,
      loopRecoveryVersion: config?.details?.loopRecoveryVersion ?? null
    },
    available: observations.length > 0,
    droppedEvents,
    retention,
    auditLimitReached: observations.some((entry) => entry.phase === 'audit-limit'),
    serverCoverage: backend.flatMap((entry) =>
      (Array.isArray(entry.attempts) ? entry.attempts : []).map((attempt) => ({
        requestId: entry.requestId,
        channelId: attempt?.channelId,
        version: serverAttemptTiming(attempt?.timing)?.toolArgumentAuditVersion ?? null,
        boundaries: serverAttemptTiming(attempt?.timing)?.toolArgumentCoverage ?? []
      }))
    ),
    notes: [
      '客户端接收边界指 Provider HTTP 响应；API 两侧记录需要部署相应服务端版本，缺失时不能归因于上游。',
      '仅记录参数字节数、字段数量及本轮专用的带密钥指纹，不记录参数正文；不同轮次指纹不可比较。',
      'MCP 不提供原始工具调用 ID；只有工具名和指纹同时唯一时才关联执行记录。重复同参调用不强行配对。',
      '缺失、截断、不完整及未关联记录均不能按空参数处理；空对象只有违反已观察到的必填字段时才算异常。'
    ],
    calls,
    serverCalls,
    observations
  }
}

export function formatToolArgumentReport(report: ReturnType<typeof buildToolArgumentReport>): string {
  const meanings: Record<string, string> = {
    insufficient: '证据不足或响应未完整结束，不能判断参数丢失位置',
    'wire-protocol-conflict': '响应的增量参数与最终快照不一致，需检查协议兼容性',
    'missing-at-provider-boundary': '客户端接收边界已缺少工具声明的必填字段；继续核查 API 转换与上游输出',
    'changed-before-native-execution': '同一调用在接收与原生解析阶段的参数不同，需检查客户端原生解析',
    'wire-and-native-consistent': '同一调用在接收与原生解析阶段的参数一致'
  }
  return [
    '逐次工具参数对账（不含参数正文）',
    `参数对账版本：${report.runtimeCapabilities.toolArgumentAuditVersion ?? '未记录（旧主进程或未采集）'}`,
    `重复操作恢复版本：${report.runtimeCapabilities.loopRecoveryVersion ?? '未记录（旧主进程或未采集）'}`,
    ...report.notes,
    `时间线因容量限制丢弃的事件数：${report.droppedEvents}；缺失调用不能据此补零或推断。`,
    ...(report.retention
      ? [
          `其中普通过程记录丢弃 ${report.retention.generalDroppedEvents} 条；请求/参数专用记录丢弃 ${report.retention.protectedDroppedEvents} 条。`
        ]
      : ['旧记录未区分普通时间线与请求/参数记录的容量限制。']),
    ...(report.auditLimitReached ? ['参数采集器已达到本轮上限，后续调用证据不完整。'] : []),
    '',
    ...(report.available ? [] : ['本轮没有工具参数对账记录，请完整重启客户端主进程后采集新任务。']),
    ...report.serverCalls.map(
      (call) =>
        `API ${call.requestId ?? '未知请求'} / ${call.nativeToolCallId ?? '无调用 ID'}：${{ 'changed-inside-api': '同一调用的参数在 API 转换前后不同，需检查 API 转换', 'api-boundaries-consistent': 'API 转换前后参数一致', insufficient: 'API 两侧记录不足或尚未完整结束' }[call.finding]}。`
    ),
    ...report.calls.map(
      (call, index) =>
        `${index + 1}. ${call.toolName ?? '未知工具'} / ${call.nativeToolCallId ?? '无调用 ID'}\n` +
        `   ${meanings[call.finding]}；执行记录关联：${call.executionCorrelation}。\n` +
        `   请求：${call.requestId ?? call.transportRequestId ?? '未记录'}；接收参数：${call.wire.argumentState ?? '未知'}；缺少必填字段数：${call.wire.missingRequiredKeys ?? '未核验'}。`
    )
  ].join('\n')
}
