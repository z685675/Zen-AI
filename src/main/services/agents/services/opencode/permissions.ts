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
  ownsSession?: (id: string) => boolean | Promise<boolean>
  onQuestion?: (question: OpenCodeEvent['properties']) => void
}) {
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  let checking = false
  const timer = setInterval(() => {
    if (checking || signal.aborted || !input.hasUnfinishedTools()) return
    checking = true
    void input.client
      .request<OpenCodeEvent['properties'][]>('/permission', 'GET', undefined, signal)
      .then(async (pending) => {
        if (signal.aborted) return
        if (!Array.isArray(pending)) throw new Error('OpenCode returned an invalid pending permission list')
        for (const permission of pending) {
          if (
            typeof permission.id === 'string' &&
            (permission.sessionID === input.sessionId || (await input.ownsSession?.(permission.sessionID)))
          )
            input.onPermission(permission)
        }
        if (input.onQuestion && !signal.aborted) {
          const questions = await input.client.request<OpenCodeEvent['properties'][]>(
            '/question',
            'GET',
            undefined,
            signal
          )
          if (signal.aborted || !Array.isArray(questions)) return
          for (const question of questions) {
            if (
              typeof question.id === 'string' &&
              (question.sessionID === input.sessionId || (await input.ownsSession?.(question.sessionID)))
            )
              input.onQuestion(question)
          }
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
