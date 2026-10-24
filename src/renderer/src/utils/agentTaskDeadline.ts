/** Exact local reason only; never infer a task limit from a provider's timeout. */
export function getAgentTaskDeadlineKind(error: unknown): 'execution' | 'inactivity' | 'human-wait' | undefined {
  let value = error
  for (let depth = 0; depth < 4; depth++) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        return
      }
    }
    if (!value || typeof value !== 'object') return
    const item = value as { code?: unknown; cause?: unknown }
    if (item.code === 'agent_execution_timeout') return 'execution'
    if (item.code === 'agent_inactivity_timeout') return 'inactivity'
    if (item.code === 'agent_human_wait_timeout') return 'human-wait'
    value = item.cause
  }
  return undefined
}
