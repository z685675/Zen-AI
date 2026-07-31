import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import {
  classifyDeepResearchFollowUp,
  findResumableDeepResearchTask,
  getAgentSessionDeepResearchCacheKey,
  getDeepResearchTaskAction,
  isDeepResearchTaskMessage,
  isDeepResearchTaskRootMessage,
  shouldStartDeepResearchImmediately
} from '../agentDeepResearch'

const taskMessage = (
  id: string,
  status: NonNullable<Message['providerMetadata']>['deepResearch']['status'],
  action: NonNullable<Message['providerMetadata']>['deepResearch']['action'] = 'plan',
  taskId = id
) =>
  ({
    id,
    providerMetadata: {
      deepResearch: {
        taskId,
        version: 1,
        requestedAt: '2026-07-31T00:00:00.000Z',
        action,
        status
      }
    }
  }) as Pick<Message, 'id' | 'providerMetadata'>

describe('agent deep research task helpers', () => {
  it('scopes armed state to one agent session', () => {
    expect(getAgentSessionDeepResearchCacheKey('agent:1', 'session/1')).toBe(
      'agent-deep-research:agent%3A1:session%2F1'
    )
    expect(getAgentSessionDeepResearchCacheKey('agent-1', 'session-1')).not.toBe(
      getAgentSessionDeepResearchCacheKey('agent-1', 'session-2')
    )
  })

  it('recognizes persisted deep research task metadata', () => {
    expect(
      isDeepResearchTaskMessage({
        providerMetadata: {
          deepResearch: {
            taskId: 'task-1',
            version: 1,
            requestedAt: '2026-07-31T00:00:00.000Z'
          }
        }
      })
    ).toBe(true)
    expect(isDeepResearchTaskMessage({ providerMetadata: {} })).toBe(false)
  })

  it('distinguishes a new task from a continuation message', () => {
    const root = taskMessage('message-1', 'planning')
    const continuation = taskMessage('message-2', 'researching', 'start', 'message-1')

    expect(isDeepResearchTaskRootMessage(root)).toBe(true)
    expect(isDeepResearchTaskRootMessage(continuation)).toBe(false)
    expect(getDeepResearchTaskAction(root)).toBe('plan')
    expect(getDeepResearchTaskAction(continuation)).toBe('start')
  })

  it('recognizes immediate execution and confirmation without swallowing plan revisions', () => {
    expect(shouldStartDeepResearchImmediately('不用确认，直接开始研究')).toBe(true)
    expect(classifyDeepResearchFollowUp('可以')).toBe('start')
    expect(classifyDeepResearchFollowUp('Okay')).toBe('start')
    expect(classifyDeepResearchFollowUp('按计划执行')).toBe('start')
    expect(classifyDeepResearchFollowUp('可以，但请增加中国市场')).toBe('revise')
    expect(classifyDeepResearchFollowUp('只看中国市场')).toBe('revise')
    expect(classifyDeepResearchFollowUp('今天先聊点别的')).toBeUndefined()
  })

  it('restores only the newest non-completed task with explicit persisted status', () => {
    expect(
      findResumableDeepResearchTask([
        taskMessage('task-1', 'completed'),
        taskMessage('task-2', 'awaiting_confirmation')
      ])
    ).toMatchObject({ taskId: 'task-2', status: 'awaiting_confirmation' })

    expect(
      findResumableDeepResearchTask([
        taskMessage('task-1', 'awaiting_confirmation'),
        taskMessage('task-2', 'completed', 'start', 'task-1')
      ])
    ).toBeUndefined()

    expect(
      findResumableDeepResearchTask([
        {
          providerMetadata: {
            deepResearch: {
              taskId: 'legacy-task',
              version: 1,
              requestedAt: '2026-07-31T00:00:00.000Z'
            }
          }
        }
      ])
    ).toBeUndefined()
  })
})
