/** Meaningful-progress watchdog only: never submits, retries or replays a task.
 * Busy/status heartbeats and reconnects must NOT call progress().
 */
export function createTaskDeadline(
  onTimeout: (kind: 'inactivity' | 'human-wait') => void,
  inactivityMs = 15 * 60_000,
  humanWaitMs = 30 * 60_000
) {
  const waiting = new Set<string>()
  let remainingInactivity = inactivityMs
  let remainingWait = humanWaitMs
  let started = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let waitingPhase = false
  const schedule = () => {
    timer = setTimeout(
      () => {
        if (closed) return
        closed = true
        onTimeout(waitingPhase ? 'human-wait' : 'inactivity')
      },
      Math.max(0, waitingPhase ? remainingWait : remainingInactivity)
    )
  }
  const change = () => {
    const next = waiting.size > 0
    if (closed || next === waitingPhase) return
    clearTimeout(timer)
    const elapsed = Math.max(0, performance.now() - started)
    if (waitingPhase) remainingWait -= elapsed
    else remainingInactivity -= elapsed
    if ((waitingPhase ? remainingWait : remainingInactivity) <= 0) {
      closed = true
      onTimeout(waitingPhase ? 'human-wait' : 'inactivity')
      return
    }
    started = performance.now()
    waitingPhase = next
    // A user returning from login/approval gets a fresh inactivity window.
    if (!next) remainingInactivity = inactivityMs
    schedule()
  }
  schedule()
  return {
    progress() {
      if (closed || waitingPhase) return
      clearTimeout(timer)
      remainingInactivity = inactivityMs
      started = performance.now()
      schedule()
    },
    wait(id: string) {
      if (!closed) {
        waiting.add(id)
        change()
      }
    },
    continue(id: string) {
      waiting.delete(id)
      change()
    },
    get waiting() {
      return waiting.size > 0
    },
    dispose() {
      closed = true
      clearTimeout(timer)
      waiting.clear()
    }
  }
}
