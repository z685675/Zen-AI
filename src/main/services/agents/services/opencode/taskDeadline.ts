/** Product time budget only: never submits, retries or replays a task. */
export function createTaskDeadline(
  onTimeout: (kind: 'execution' | 'human-wait') => void,
  executionMs = 15 * 60_000,
  humanWaitMs = 30 * 60_000
) {
  const waiting = new Set<string>()
  let remainingExecution = executionMs
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
        onTimeout(waitingPhase ? 'human-wait' : 'execution')
      },
      Math.max(0, waitingPhase ? remainingWait : remainingExecution)
    )
  }
  const change = () => {
    const next = waiting.size > 0
    if (closed || next === waitingPhase) return
    clearTimeout(timer)
    const elapsed = Math.max(0, performance.now() - started)
    if (waitingPhase) remainingWait -= elapsed
    else remainingExecution -= elapsed
    if ((waitingPhase ? remainingWait : remainingExecution) <= 0) {
      closed = true
      onTimeout(waitingPhase ? 'human-wait' : 'execution')
      return
    }
    started = performance.now()
    waitingPhase = next
    schedule()
  }
  schedule()
  return {
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
