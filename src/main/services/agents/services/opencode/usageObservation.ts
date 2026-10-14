import {
  isReportedTokenCount,
  type OpenCodeTurnDiagnostics,
  type OpenCodeUsageObservation,
  type ReportedUsage
} from '../../../../../../packages/shared/agents/opencodeDiagnostics'

const MAX_FRAME = 256 * 1024
const MAX_JSON = 1024 * 1024
const record = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : undefined

/** Bounded observer of response bytes; never forwards, rewrites or retains content. */
export class OpenCodeUsageObserver {
  private buffer = ''
  private dropping = false
  private limited = false
  private decoder = new TextDecoder()
  private usage: ReportedUsage = {}
  private format: OpenCodeUsageObservation['format'] = 'unknown'

  constructor(private contentType: string) {}

  push(bytes: Uint8Array) {
    // Decode in bounded slices even if the transport delivers a large chunk.
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
      this.text(this.decoder.decode(bytes.subarray(offset, offset + 16 * 1024), { stream: true }))
    }
  }

  private text(text: string) {
    if (!this.contentType.includes('text/event-stream')) {
      if (this.dropping) return
      if (this.buffer.length + text.length > MAX_JSON) {
        this.buffer = ''
        this.dropping = this.limited = true
      } else this.buffer += text
      return
    }
    // SSE data frames may span network chunks and multiple data lines.
    this.buffer += text
    let boundary: RegExpExecArray | null
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, boundary.index)
      if (!this.dropping && frame.length <= MAX_FRAME) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        this.json(data)
      } else this.limited = true
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length)
      this.dropping = false
    }
    if (this.buffer.length > MAX_FRAME) {
      this.dropping = this.limited = true
      this.buffer = this.buffer.slice(-3)
    }
  }

  private json(text: string) {
    if (!/"(?:usage|usageMetadata)"\s*:/.test(text)) return
    try {
      const body = record(JSON.parse(text))
      if (!body) return
      const usage = record(body.usage) ?? record(body.response?.usage) ?? record(body.message?.usage)
      const google = record(body.usageMetadata)
      const next: ReportedUsage = {}
      const set = (key: keyof ReportedUsage, value: unknown) => {
        if (isReportedTokenCount(value)) next[key] = value
      }
      if (google) {
        this.format = 'gemini'
        set('input', google.promptTokenCount)
        set('cacheRead', google.cachedContentTokenCount)
        set('reasoning', google.thoughtsTokenCount)
        if (isReportedTokenCount(google.candidatesTokenCount))
          set('output', google.candidatesTokenCount + (next.reasoning ?? 0))
      } else if (usage && ('prompt_tokens' in usage || 'completion_tokens' in usage)) {
        this.format = 'openai'
        set('input', usage.prompt_tokens)
        set('output', usage.completion_tokens)
        set('cacheRead', usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? usage.cache_read_tokens)
        set('cacheWrite', usage.cache_creation_input_tokens ?? usage.cache_write_tokens)
        set('reasoning', usage.completion_tokens_details?.reasoning_tokens)
      } else if (
        usage &&
        (body.type === 'message' ||
          (typeof body.type === 'string' && body.type.startsWith('message_')) ||
          'cache_read_input_tokens' in usage ||
          'cache_creation_input_tokens' in usage)
      ) {
        this.format = 'anthropic'
        set('cacheRead', usage.cache_read_input_tokens)
        set('cacheWrite', usage.cache_creation_input_tokens)
        const combined = { ...this.usage, ...next }
        if (isReportedTokenCount(usage.input_tokens))
          set('input', usage.input_tokens + (combined.cacheRead ?? 0) + (combined.cacheWrite ?? 0))
        set('output', usage.output_tokens)
      } else if (usage && ('input_tokens' in usage || 'output_tokens' in usage)) {
        this.format = 'responses'
        set('input', usage.input_tokens)
        set('output', usage.output_tokens)
        set('cacheRead', usage.input_tokens_details?.cached_tokens)
        set('reasoning', usage.output_tokens_details?.reasoning_tokens)
      }
      this.usage = { ...this.usage, ...next }
    } catch {
      /* Unknown/invalid frames must never break the model stream. */
    }
  }

  finish(complete: boolean): OpenCodeUsageObservation {
    this.text(this.decoder.decode())
    if (!this.dropping && !this.contentType.includes('text/event-stream')) this.json(this.buffer)
    this.buffer = ''
    return { usage: { ...this.usage }, format: this.format, complete: complete && !this.limited }
  }
}

export class OpenCodeUsageTotals {
  private totals: ReportedUsage = {}
  private observed = 0
  private reported = 0
  private incomplete = 0
  private reports = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

  observe(observation: OpenCodeUsageObservation) {
    this.observed++
    if (!observation.complete) this.incomplete++
    if (Object.keys(observation.usage).length) this.reported++
    for (const [key, count] of Object.entries(observation.usage)) {
      if (!isReportedTokenCount(count)) continue
      const field = key as keyof ReportedUsage
      const total = (this.totals[field] ?? 0) + count
      if (isReportedTokenCount(total)) this.totals[field] = total
      if (field in this.reports) this.reports[field as keyof typeof this.reports]++
    }
  }

  snapshot(
    providerId: string,
    modelId: string,
    performance: OpenCodeTurnDiagnostics['performance']
  ): OpenCodeTurnDiagnostics {
    return {
      version: 1,
      providerId,
      modelId,
      usage: { ...this.totals },
      observedRequests: this.observed,
      reportedRequests: this.reported,
      inputReports: this.reports.input,
      outputReports: this.reports.output,
      cacheReadReports: this.reports.cacheRead,
      cacheWriteReports: this.reports.cacheWrite,
      incompleteRequests: this.incomplete,
      performance
    }
  }
}
