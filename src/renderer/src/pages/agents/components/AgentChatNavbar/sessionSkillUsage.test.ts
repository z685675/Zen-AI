import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { currentTurnSkillUsage } from './sessionSkillUsage'

describe('evidence-only per-turn skill usage', () => {
  it('ignores past turns, name mentions, other tools and streamed arguments', () => {
    const messages = [
      { role: 'user', blocks: [] },
      { role: 'assistant', blocks: ['old'] },
      { role: 'user', blocks: [] },
      { role: 'assistant', blocks: ['mention', 'other', 'pending', 'done', 'failed'] }
    ] as Message[]
    const tool = (name: string, skill: string, status: string) => ({
      type: 'tool',
      toolName: name,
      metadata: { rawMcpToolResponse: { tool: { name }, arguments: { name: skill }, status } }
    })
    const blocks = {
      old: tool('skill', 'old-skill', 'done'),
      mention: { type: 'main_text', content: 'I used xlsx' },
      other: tool('read', 'xlsx', 'done'),
      pending: tool('skill', 'not-started', 'pending'),
      done: tool('skill', 'xlsx', 'done'),
      failed: tool('skill', 'docx', 'error')
    } as unknown as Record<string, MessageBlock>
    expect([...currentTurnSkillUsage(messages, blocks)]).toEqual([
      ['xlsx', 'done'],
      ['docx', 'error']
    ])
  })
  it('does not infer use without a user turn or structured input', () => {
    expect(currentTurnSkillUsage([{ role: 'assistant', blocks: [] }] as Message[], {}).size).toBe(0)
    expect(
      currentTurnSkillUsage(
        [
          { role: 'user', blocks: [] },
          { role: 'assistant', blocks: ['tool'] }
        ] as Message[],
        {
          tool: {
            type: 'tool',
            toolName: 'skill',
            metadata: { rawMcpToolResponse: { tool: { name: 'skill' }, arguments: 'xlsx', status: 'done' } }
          }
        } as never
      ).size
    ).toBe(0)
  })
})
