import { AgentTaskLimitError } from '@shared/agents/taskConcurrency'
import { describe, expect, it } from 'vitest'

import { acquireSessionActivity, assertSessionNotContinuing } from '../sessionActivity'

describe('shared continuation lease', () => {
  it('prevents desktop/IM/task activity while copying and releases idempotently', () => {
    const release = acquireSessionActivity('lease-test', 'continuation')
    try {
      expect(() => acquireSessionActivity('lease-test', 'run')).toThrow('Stop')
      expect(() => assertSessionNotContinuing('lease-test')).toThrow('snapshot')
    } finally {
      release()
      release()
    }
    expect(() => assertSessionNotContinuing('lease-test')).not.toThrow()
    acquireSessionActivity('lease-test', 'run')()
  })
  it('prevents copying a running task without blocking other conversations', () => {
    const release = acquireSessionActivity('run-test', 'run')
    try {
      expect(() => acquireSessionActivity('run-test', 'continuation')).toThrow('Stop')
      acquireSessionActivity('other-test', 'continuation')()
    } finally {
      release()
    }
  })
})

describe('new and deprecated assistants share task slots', () => {
  it('rejects the second task in normal mode without reserving an extra slot', () => {
    const release = acquireSessionActivity('new-task', 'run', 1)
    try {
      expect(() => acquireSessionActivity('old-task', 'run', 1)).toThrow(AgentTaskLimitError)
      acquireSessionActivity('migration-only', 'continuation', 1)()
    } finally {
      release()
      release()
    }
    acquireSessionActivity('old-task', 'run', 1)()
  })

  it('allows only three combined tasks in developer mode and reuses released slots', () => {
    const releases = ['new-1', 'old-1', 'new-2'].map((id) => acquireSessionActivity(id, 'run', 3))
    try {
      expect(() => acquireSessionActivity('old-2', 'run', 3)).toThrow(AgentTaskLimitError)
      releases[1]()
      // Idempotent release must not accidentally release a newer task with the same ID.
      const replacement = acquireSessionActivity('old-1', 'run', 3)
      try {
        releases[1]()
        expect(() => acquireSessionActivity('old-2', 'run', 3)).toThrow(AgentTaskLimitError)
      } finally {
        replacement()
      }
    } finally {
      releases.forEach((release) => release())
    }
  })

  it('does not terminate existing tasks when developer mode is turned off', () => {
    const releases = ['mode-1', 'mode-2', 'mode-3'].map((id) => acquireSessionActivity(id, 'run', 3))
    try {
      expect(() => acquireSessionActivity('mode-4', 'run', 1)).toThrow(AgentTaskLimitError)
      releases[0]()
      releases[1]()
      expect(() => acquireSessionActivity('mode-4', 'run', 1)).toThrow(AgentTaskLimitError)
      releases[2]()
      acquireSessionActivity('mode-4', 'run', 1)()
    } finally {
      releases.forEach((release) => release())
    }
  })
})
