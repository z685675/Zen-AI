import { APP_QUIT_CLEANUP_TIMEOUT_MS } from '@shared/config/constant'

/** Each owner must stop even if a preceding service fails, before closing storage. */
export async function runQuitCleanup(
  steps: Array<{ name: string; stop: () => void | Promise<void> }>,
  onError: (name: string, error: unknown) => void,
  onStep?: (name: string, state: 'started' | 'completed' | 'failed', durationMs: number) => void
): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps) {
    const started = performance.now()
    onStep?.(step.name, 'started', 0)
    try {
      await step.stop()
      onStep?.(step.name, 'completed', Math.round(performance.now() - started))
    } catch (error) {
      failures.push(error)
      onStep?.(step.name, 'failed', Math.round(performance.now() - started))
      onError(step.name, error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Application service cleanup failed')
}

/** Electron does not await promises returned by will-quit listeners. Hold the
 * first quit until native/process cleanup is settled, then allow exactly one
 * final quit. Repeated close clicks do not start duplicate cleanup. */
export function createAsyncQuitGuard(options: {
  cleanup: () => Promise<void>
  quit: (cleanupError?: unknown) => void
  onError: (error: unknown) => void
  timeoutMs?: number
}) {
  let ready = false
  let pending: Promise<void> | undefined
  return (event: { preventDefault: () => void }) => {
    if (ready) return
    event.preventDefault()
    if (pending) return
    pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let failed = false
      let failure: unknown
      try {
        await Promise.race([
          Promise.resolve().then(options.cleanup),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Application cleanup timed out')),
              options.timeoutMs ?? APP_QUIT_CLEANUP_TIMEOUT_MS
            )
          })
        ])
      } catch (error) {
        failed = true
        failure = error ?? new Error('Application cleanup failed without an error')
        options.onError(error)
      } finally {
        clearTimeout(timer)
        ready = true
        if (failed) options.quit(failure)
        else options.quit()
      }
    })()
  }
}
