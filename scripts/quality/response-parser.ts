type Outcome =
  | 'receiving'
  | 'complete'
  | 'empty-body'
  | 'empty-output'
  | 'missing-completion'
  | 'malformed-json'
  | 'incompatible-protocol'
  | 'upstream-error'
  | 'http-error'
  | 'transport-interrupted'
  | 'limit-exceeded'

export interface ResponseEvidence {
  requestedStream: boolean
  contentType: 'sse' | 'json' | 'html' | 'other' | 'missing'
  framing: 'unknown' | 'sse' | 'json' | 'html'
  bytes: number
  chunks: number
  dataEvents: number
  jsonEvents: number
  commentLines: number
  otherLines: number
  invalidJsonEvents: number
  openAIEvents: number
  anthropicEvents: number
  geminiEvents: number
  responsesEvents: number
  errorEvents: number
  usageEvents: number
  sawDone: boolean
  finishReasons: string[]
  hasText: boolean
  hasToolCalls: boolean
  reachedEof: boolean
  outcome: Outcome
}

const MAX_FRAME_BYTES = 1024 * 1024
const MAX_BODY_BYTES = 16 * 1024 * 1024
const finishReasons = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter', 'error'])
const anthropicTypes = new Set([
  'message',
  'message_start',
  'message_delta',
  'message_stop',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'ping'
])

export function describeResponse(evidence: ResponseEvidence) {
  return `响应结构：${evidence.outcome}；Content-Type=${evidence.contentType}，正文格式=${evidence.framing}，字节=${evidence.bytes}，SSE事件=${evidence.dataEvents}，JSON事件=${evidence.jsonEvents}，正文=${evidence.hasText ? '有' : '无'}，工具调用=${evidence.hasToolCalls ? '有' : '无'}，finish=${evidence.finishReasons.join(',') || '无'}，DONE=${evidence.sawDone ? '有' : '无'}，EOF=${evidence.reachedEof ? '已到达' : '未到达'}`
}

/** Observes, but never rewrites, the upstream body. Evidence contains only fixed labels,
 * counters and booleans: no text, tool arguments, arbitrary event names or raw headers. */
export class QualityResponseParser {
  readonly evidence: ResponseEvidence
  private decoder = new TextDecoder('utf-8', { fatal: true })
  private line = ''
  private skipLF = false
  private firstCharacter = true
  private frameBytes = 0
  private data: string[] = []
  private fallback = ''
  private fallbackTruncated = false
  private jsonBody = ''

  constructor(
    stream: boolean,
    contentType: string | null,
    private readonly inspect: (value: Record<string, any>) => void
  ) {
    // Deliberately do not retain arbitrary Content-Type parameters (which can contain secrets).
    const mime = contentType?.split(';', 1)[0].trim().toLowerCase()
    this.evidence = {
      requestedStream: stream,
      contentType: !mime
        ? 'missing'
        : mime === 'text/event-stream'
          ? 'sse'
          : mime === 'application/json' || mime.endsWith('+json')
            ? 'json'
            : mime === 'text/html'
              ? 'html'
              : 'other',
      framing: 'unknown',
      bytes: 0,
      chunks: 0,
      dataEvents: 0,
      jsonEvents: 0,
      commentLines: 0,
      otherLines: 0,
      invalidJsonEvents: 0,
      openAIEvents: 0,
      anthropicEvents: 0,
      geminiEvents: 0,
      responsesEvents: 0,
      errorEvents: 0,
      usageEvents: 0,
      sawDone: false,
      finishReasons: [],
      hasText: false,
      hasToolCalls: false,
      reachedEof: false,
      outcome: 'receiving'
    }
  }

  private fail(outcome: Outcome, message: string): never {
    this.evidence.outcome = outcome
    throw new Error(message)
  }

  private decode(chunk?: Uint8Array) {
    try {
      return chunk ? this.decoder.decode(chunk, { stream: true }) : this.decoder.decode()
    } catch {
      this.fail('malformed-json', '上游响应包含无效或截断的UTF-8编码。')
    }
  }

  push(chunk: Uint8Array) {
    this.evidence.bytes += chunk.length
    this.evidence.chunks++
    if (this.evidence.bytes > MAX_BODY_BYTES) this.fail('limit-exceeded', '上游响应超过质检证据限制。')
    this.consume(this.decode(chunk))
  }

  private consume(text: string) {
    if (this.firstCharacter && text.length) {
      this.firstCharacter = false
      if (text.startsWith('\uFEFF')) text = text.slice(1)
    }
    if (!this.evidence.requestedStream) {
      this.jsonBody += text
      return
    }
    // Keep a bounded fallback solely to recognize JSON/HTML sent instead of SSE.
    // It is never exposed in evidence/errors and discarded once SSE data is observed.
    if (!this.evidence.dataEvents) {
      const remaining = MAX_FRAME_BYTES - this.fallback.length
      this.fallback += text.slice(0, remaining)
      this.fallbackTruncated ||= text.length > remaining
    }
    let start = 0
    for (let index = 0; index < text.length; index++) {
      const character = text[index]
      if (this.skipLF) {
        this.skipLF = false
        if (character === '\n') {
          start = index + 1
          continue
        }
      }
      if (character !== '\n' && character !== '\r') continue
      this.append(text.slice(start, index))
      this.consumeLine()
      this.skipLF = character === '\r'
      start = index + 1
    }
    this.append(text.slice(start))
  }

  private append(text: string) {
    this.frameBytes += Buffer.byteLength(text)
    if (this.frameBytes > MAX_FRAME_BYTES) this.fail('limit-exceeded', 'SSE单个事件超过1MiB限制。')
    this.line += text
  }

  private consumeLine() {
    const line = this.line
    this.line = ''
    if (!line) {
      this.dispatch()
      this.frameBytes = 0
      return
    }
    this.frameBytes++
    if (line.startsWith(':')) {
      this.evidence.commentLines++
      return
    }
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    if (field === 'data') {
      const value = colon < 0 ? '' : line.slice(colon + 1)
      this.data.push(value.startsWith(' ') ? value.slice(1) : value)
    } else this.evidence.otherLines++
  }

  private dispatch() {
    if (!this.data.length) return
    const data = this.data.join('\n')
    this.data = []
    this.fallback = ''
    this.evidence.framing = 'sse'
    this.evidence.dataEvents++
    if (data.trim() === '[DONE]') this.evidence.sawDone = true
    else this.observe(this.parseJson(data))
  }

  private parseJson(text: string): Record<string, any> {
    try {
      const value = JSON.parse(text)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      // JSON.parse messages can echo private response text: never propagate them.
    }
    this.evidence.invalidJsonEvents++
    this.fail('malformed-json', '上游响应不是有效的JSON对象；未记录正文。')
  }

  private observe(value: Record<string, any>) {
    const stats = this.evidence
    stats.jsonEvents++
    if (value.error) {
      stats.errorEvents++
      stats.outcome = 'upstream-error'
      this.inspect(value)
      this.fail('upstream-error', '上游返回错误事件。')
    }
    if (Array.isArray(value.candidates)) stats.geminiEvents++
    else if (anthropicTypes.has(value.type)) stats.anthropicEvents++
    else if (value.object === 'response' || (typeof value.type === 'string' && value.type.startsWith('response.')))
      stats.responsesEvents++
    if (stats.geminiEvents || stats.anthropicEvents || stats.responsesEvents)
      this.fail('incompatible-protocol', '上游返回了其他原生协议，而不是本批批准的OpenAI chat/completions格式。')
    if (Array.isArray(value.choices) || value.usage?.prompt_tokens !== undefined) stats.openAIEvents++
    if (value.usage) stats.usageEvents++
    for (const choice of Array.isArray(value.choices) ? value.choices : []) {
      const output = choice?.delta ?? choice?.message
      stats.hasText ||= typeof output?.content === 'string' && Boolean(output.content.trim())
      stats.hasToolCalls ||= Array.isArray(output?.tool_calls) && output.tool_calls.length > 0
      const reason = choice?.finish_reason
      if (typeof reason === 'string' && reason) {
        const label = finishReasons.has(reason) ? reason : 'other'
        if (!stats.finishReasons.includes(label)) stats.finishReasons.push(label)
        if (reason === 'error') stats.outcome = 'upstream-error'
      }
    }
    this.inspect(value)
  }

  finish() {
    this.evidence.reachedEof = true
    this.consume(this.decode())
    const stats = this.evidence
    if (!stats.bytes) this.fail('empty-body', '上游HTTP成功，但响应体为空。')
    if (!stats.requestedStream) {
      stats.framing = this.jsonBody.trimStart().startsWith('<') ? 'html' : 'json'
      if (stats.framing === 'html') this.fail('incompatible-protocol', '上游返回HTML页面，而不是JSON响应。')
      this.observe(this.parseJson(this.jsonBody))
      this.jsonBody = ''
    } else {
      if (this.line) this.consumeLine()
      // Tolerate a final SSE event without a trailing blank line, as before.
      this.dispatch()
      if (!stats.dataEvents) {
        const fallback = this.fallback.trim()
        this.fallback = ''
        if (fallback.startsWith('<')) {
          stats.framing = 'html'
          this.fail('incompatible-protocol', '上游返回HTML页面，而不是SSE流。')
        }
        if (/^[{[]/.test(fallback) && !this.fallbackTruncated) {
          stats.framing = 'json'
          this.observe(this.parseJson(fallback))
          this.fail('incompatible-protocol', '请求要求SSE流，但上游返回普通JSON；未将其伪装为流式成功。')
        }
        if (stats.commentLines === 0 || stats.otherLines > 0)
          this.fail('incompatible-protocol', '上游没有返回可识别的OpenAI SSE数据事件。')
      }
    }
    if (!stats.finishReasons.length && !stats.sawDone) this.fail('missing-completion', '上游缺少最终完成标记。')
    if (!stats.hasText && !stats.hasToolCalls) this.fail('empty-output', '上游返回空响应，没有正文或工具调用。')
    stats.outcome = 'complete'
  }

  interrupted() {
    if (this.evidence.outcome === 'receiving') this.evidence.outcome = 'transport-interrupted'
  }
}
