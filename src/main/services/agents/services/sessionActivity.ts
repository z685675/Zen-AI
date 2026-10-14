import { AgentTaskLimitError } from '@shared/agents/taskConcurrency'

import { assertAssistantDataAvailable } from './dataOperationGate'

/** One lease per session, shared by desktop, IM, scheduler and continuation. */
const activities = new Map<string, 'run' | 'continuation'>()

export function hasAnySessionActivity(): boolean {
  return activities.size > 0
}

export function hasSessionActivity(id: string): boolean {
  return activities.has(id)
}

export function activeSessionTaskCount(): number {
  return [...activities.values()].filter((activity) => activity === 'run').length
}

export function acquireSessionActivity(
  id: string,
  activity: 'run' | 'continuation',
  maxConcurrentRuns = Number.POSITIVE_INFINITY
): () => void {
  assertAssistantDataAvailable()
  if (activities.has(id)) {
    throw Object.assign(new Error('Stop the active task before continuing this conversation'), {
      code: 'continuation_busy'
    })
  }
  // Reserve synchronously before any async startup, across all runtimes and
  // callers. Preparing a history copy is not a model task and uses no slot.
  if (activity === 'run') {
    let activeRuns = 0
    for (const current of activities.values()) {
      if (current === 'run') activeRuns++
    }
    if (activeRuns >= maxConcurrentRuns) throw new AgentTaskLimitError(maxConcurrentRuns, activeRuns)
  }
  activities.set(id, activity)
  let released = false
  return () => {
    if (released) return
    released = true
    activities.delete(id)
  }
}

export function assertSessionNotContinuing(id: string): void {
  if (activities.get(id) === 'continuation') {
    throw Object.assign(new Error('A continuation snapshot is being prepared'), { code: 'continuation_busy' })
  }
}
