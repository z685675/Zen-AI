import { describe, expect, it } from 'vitest'

import { AgentTaskLimitError, getAgentTaskLimit, getAgentTaskLimitDetails } from './taskConcurrency'

describe('assistant task capacity contract', () => {
  it('allows one normal-mode task and three developer-mode tasks', () => {
    expect(getAgentTaskLimit(false)).toBe(1)
    expect(getAgentTaskLimit(true)).toBe(3)
  })

  it('retains the local admission marker across JSON transport and history persistence', () => {
    const error = new AgentTaskLimitError(3, 3)
    expect(error.status).toBe(409)
    expect(error.zenFailureStage).toBe('local-task-admission')
    expect(getAgentTaskLimitDetails(JSON.parse(JSON.stringify(error)))).toEqual({ limit: 3, activeTasks: 3 })
  })

  it('does not mistake upstream rate limits or network failures for local capacity', () => {
    for (const error of [null, undefined, 'agent_task_limit', new Error('Failed to fetch'), { status: 429 }]) {
      expect(getAgentTaskLimitDetails(error)).toBeUndefined()
    }
  })

  it('recognizes the SDK wrapper but safely ignores cyclic or unrelated causes', () => {
    expect(
      getAgentTaskLimitDetails({ name: 'AI_ProviderSpecificError', cause: new AgentTaskLimitError(3, 3) })
    ).toEqual({ limit: 3, activeTasks: 3 })
    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(getAgentTaskLimitDetails(cyclic)).toBeUndefined()
    expect(getAgentTaskLimitDetails({ cause: new Error('429 quota exhausted') })).toBeUndefined()
  })
})
