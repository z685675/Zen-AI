import type { DiagnosticEvent } from './diagnostics'

export const LIVE_RENDER_MEASUREMENT = 'live-visible-terminal-transition-v1'

/** Old mount-time observations cannot prove how long a live UI update took. */
export function findLiveRenderCommit(events: DiagnosticEvent[], startedAt?: string, finishedAt?: string) {
  const start = Date.parse(startedAt ?? '')
  const finish = Date.parse(finishedAt ?? '')
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return undefined
  let first: DiagnosticEvent | undefined
  for (const event of events) {
    if (event.stage !== 'ui' || event.event !== 'render-committed') continue
    const details = event.details
    const active = Date.parse(typeof details?.observedActiveAt === 'string' ? details.observedActiveAt : '')
    const responseEnd = Date.parse(typeof details?.responseFinishedAt === 'string' ? details.responseFinishedAt : '')
    const committed = Date.parse(event.at)
    if (
      details?.measurement === LIVE_RENDER_MEASUREMENT &&
      responseEnd === finish &&
      Number.isFinite(active) &&
      active >= start &&
      active <= finish &&
      Number.isFinite(committed) &&
      committed >= finish &&
      (!first || committed < Date.parse(first.at))
    ) {
      first = event
    }
  }
  return first
}
