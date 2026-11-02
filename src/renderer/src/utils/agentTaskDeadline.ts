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
    const item = value as { code?: unknown; name?: unknown; cause?: unknown }
    if (item.name === 'AgentDeepResearchTimeoutError') return 'execution'
    if (item.code === 'agent_execution_timeout') return 'execution'
    if (item.code === 'agent_inactivity_timeout') return 'inactivity'
    if (item.code === 'agent_human_wait_timeout') return 'human-wait'
    value = item.cause
  }
  return undefined
}

/** Keep historical 180s failures accurate too; an unmarked provider timeout
 * must never be presented as our local task deadline. */
export function getAgentTaskDeadlineSeconds(error: unknown): number | undefined {
  if (!getAgentTaskDeadlineKind(error)) return
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
    const item = value as { timeoutMs?: unknown; code?: unknown; name?: unknown; message?: unknown; cause?: unknown }
    const local =
      ['agent_execution_timeout', 'agent_inactivity_timeout', 'agent_human_wait_timeout'].includes(String(item.code)) ||
      item.name === 'AgentDeepResearchTimeoutError'
    if (local && typeof item.timeoutMs === 'number' && Number.isFinite(item.timeoutMs) && item.timeoutMs > 0)
      return Math.ceil(item.timeoutMs / 1000)
    if (local && typeof item.message === 'string') {
      const match = /(?:progress for|within|context for) (\d+) seconds/.exec(item.message)
      if (match && Number(match[1]) > 0) return Number(match[1])
      if (item.name === 'AgentDeepResearchTimeoutError') {
        const minutes = /达到\s*(\d+)\s*分钟安全时限/.exec(item.message)
        if (minutes && Number(minutes[1]) > 0) return Number(minutes[1]) * 60
      }
    }
    value = item.cause
  }
  return
}
