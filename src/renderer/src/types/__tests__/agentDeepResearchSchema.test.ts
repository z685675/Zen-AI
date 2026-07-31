import { describe, expect, it } from 'vitest'

import { CreateSessionMessageRequestSchema } from '../agent'

describe('agent deep research request schema', () => {
  it('accepts an explicit deep research task marker', () => {
    expect(
      CreateSessionMessageRequestSchema.parse({
        content: 'Research the market',
        deep_research: true,
        deep_research_task: {
          task_id: 'task-1',
          action: 'plan'
        }
      })
    ).toMatchObject({
      content: 'Research the market',
      deep_research: true,
      deep_research_task: {
        task_id: 'task-1',
        action: 'plan'
      }
    })
  })

  it('rejects non-boolean task markers', () => {
    expect(
      CreateSessionMessageRequestSchema.safeParse({
        content: 'Research the market',
        deep_research: 'true'
      }).success
    ).toBe(false)
  })

  it('accepts confirmation and revision actions without a new task marker', () => {
    expect(
      CreateSessionMessageRequestSchema.safeParse({
        content: 'Proceed with the plan',
        deep_research_task: {
          task_id: 'task-1',
          action: 'start'
        }
      }).success
    ).toBe(true)
    expect(
      CreateSessionMessageRequestSchema.safeParse({
        content: 'Focus the plan on China',
        deep_research_task: {
          task_id: 'task-1',
          action: 'revise'
        }
      }).success
    ).toBe(true)
  })

  it('rejects invalid task actions and unsafe task IDs', () => {
    expect(
      CreateSessionMessageRequestSchema.safeParse({
        content: 'Proceed',
        deep_research_task: {
          task_id: 'task with spaces',
          action: 'start'
        }
      }).success
    ).toBe(false)
    expect(
      CreateSessionMessageRequestSchema.safeParse({
        content: 'Proceed',
        deep_research_task: {
          task_id: 'task-1',
          action: 'finish'
        }
      }).success
    ).toBe(false)
  })
})
