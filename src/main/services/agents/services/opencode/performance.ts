/** Observes existing events only. No model requests, probes or retry policy. */
export class OpenCodePerformance {
  private started: number
  private stageAt: number
  private stage?: string
  private stages: Record<string, number> = {}
  private toolStarts = new Map<string, number>()
  private toolMs = 0
  private toolCount = 0
  private requests = 0
  private headerMs = 0
  private requestMs = 0
  private retries = 0
  private firstText?: number
  private firstOutput?: number
  preparationMs?: number

  constructor(private now: () => number = () => performance.now()) {
    this.started = this.stageAt = now()
  }

  changeStage(stage: string) {
    if (this.stage === stage) return
    const now = this.now()
    if (this.stage) this.stages[this.stage] = (this.stages[this.stage] ?? 0) + Math.max(0, now - this.stageAt)
    this.stage = stage
    this.stageAt = now
  }

  transport(event: string, details: Record<string, unknown>) {
    const ms =
      typeof details.durationMs === 'number' && Number.isFinite(details.durationMs)
        ? Math.max(0, details.durationMs)
        : 0
    if (event === 'request-started') this.requests++
    if (event === 'headers-received') this.headerMs += ms
    if (['body-complete', 'failed', 'cancelled'].includes(event)) this.requestMs += ms
  }

  retry() {
    this.retries++
  }
  chunks(chunks: Array<{ type: string; toolCallId?: string; text?: string }>) {
    const now = this.now()
    for (const chunk of chunks) {
      if (chunk.type === 'tool-call' || (['text-delta', 'reasoning-delta'].includes(chunk.type) && chunk.text?.trim()))
        this.firstOutput ??= now - this.started
      if (chunk.type === 'text-delta' && chunk.text?.trim()) this.firstText ??= now - this.started
      if (chunk.type === 'tool-call' && chunk.toolCallId && !this.toolStarts.has(chunk.toolCallId)) {
        this.toolStarts.set(chunk.toolCallId, now)
        this.toolCount++
      }
      if (
        ['tool-result', 'tool-error'].includes(chunk.type) &&
        chunk.toolCallId &&
        this.toolStarts.has(chunk.toolCallId)
      ) {
        this.toolMs += Math.max(0, now - this.toolStarts.get(chunk.toolCallId)!)
        this.toolStarts.delete(chunk.toolCallId)
      }
    }
  }

  snapshot(outcome: 'completed' | 'failed' | 'cancelled') {
    const now = this.now()
    const stages = { ...this.stages }
    if (this.stage) stages[this.stage] = (stages[this.stage] ?? 0) + Math.max(0, now - this.stageAt)
    return {
      outcome,
      totalMs: Math.round(Math.max(0, now - this.started)),
      preparationMs: this.preparationMs === undefined ? null : Math.round(this.preparationMs),
      firstVisibleOutputMs: this.firstOutput === undefined ? null : Math.round(this.firstOutput),
      firstTextMs: this.firstText === undefined ? null : Math.round(this.firstText),
      stageDurationsMs: Object.fromEntries(Object.entries(stages).map(([stage, ms]) => [stage, Math.round(ms)])),
      upstreamRequests: this.requests,
      upstreamHeaderWaitMs: Math.round(this.headerMs),
      upstreamRequestMs: Math.round(this.requestMs),
      retryEvents: this.retries,
      toolCalls: this.toolCount,
      completedToolObservedMs: Math.round(this.toolMs),
      unfinishedTools: this.toolStarts.size,
      measurement:
        'Scope starts at the OpenCode turn adapter; earlier attachment saving/frontend latency are excluded. Stage times partition this wall time. Transport/tool totals can overlap and are not additive. Header wait is not first-token time. Unfinished tools/requests are not counted as completed. This observes events, not proof of an upstream cause.'
    }
  }
}
