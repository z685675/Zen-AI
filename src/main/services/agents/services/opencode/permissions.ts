import type { OpenCodeClient, OpenCodeEvent } from './client'

/** Recover a missed ephemeral permission event from the native pending list.
 * This never grants permission or resubmits a task. Only poll while a tool is
 * unfinished, and never overlap requests or prompt for another session. */
export function watchOpenCodePermissions(input: {
  client: Pick<OpenCodeClient, 'request'>
  sessionId: string
  signal: AbortSignal
  hasUnfinishedTools: () => boolean
  onPermission: (permission: OpenCodeEvent['properties']) => void
  onError: (error: unknown) => void
  intervalMs?: number
}) {
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  let checking = false
  const timer = setInterval(() => {
    if (checking || signal.aborted || !input.hasUnfinishedTools()) return
    checking = true
    void input.client
      .request<OpenCodeEvent['properties'][]>('/permission', 'GET', undefined, signal)
      .then((pending) => {
        if (signal.aborted) return
        if (!Array.isArray(pending)) throw new Error('OpenCode returned an invalid pending permission list')
        for (const permission of pending) {
          if (permission.sessionID === input.sessionId && typeof permission.id === 'string')
            input.onPermission(permission)
        }
      })
      .catch((error) => {
        if (!signal.aborted) input.onError(error)
      })
      .finally(() => {
        checking = false
      })
  }, input.intervalMs ?? 3_000)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    controller.abort('Permission watcher disposed')
  }
}
