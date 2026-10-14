export const AGENT_TASK_LIMIT_CODE = 'agent_task_limit'

export function getAgentTaskLimit(developerMode: boolean): 1 | 3 {
  return developerMode ? 3 : 1
}

export class AgentTaskLimitError extends Error {
  override name = 'AgentTaskLimitError'
  readonly code = AGENT_TASK_LIMIT_CODE
  readonly status = 409
  readonly zenFailureStage = 'local-task-admission'
  readonly zenTaskLimit: { limit: number; activeTasks: number }

  constructor(limit: number, activeTasks: number) {
    super(`The assistants already have ${activeTasks} active task(s); the shared limit is ${limit}.`)
    this.zenTaskLimit = { limit, activeTasks }
  }
}

/** Structured admission errors are local capacity notices, not model failures. */
export function getAgentTaskLimitDetails(error: unknown): { limit: number; activeTasks: number } | undefined {
  // The common stream adapter wraps non-SDK errors in ProviderSpecificError.
  // Read its bounded cause chain, not arbitrary upstream text or response bodies.
  const seen = new Set<object>()
  for (let depth = 0; depth < 4 && error && typeof error === 'object'; depth++) {
    if (seen.has(error)) return undefined
    seen.add(error)
    const record = error as Record<string, unknown>
    if (record.code === AGENT_TASK_LIMIT_CODE || record.name === 'AgentTaskLimitError') {
      const details = record.zenTaskLimit as Record<string, unknown> | undefined
      const limit = details?.limit === 3 ? 3 : 1
      const activeTasks = details?.activeTasks
      return {
        limit,
        activeTasks:
          typeof activeTasks === 'number' && Number.isFinite(activeTasks) && activeTasks >= 0 ? activeTasks : limit
      }
    }
    error = record.cause
  }
  return undefined
}
