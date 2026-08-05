import { describe, expect, it } from 'vitest'

import { DEEP_RESEARCH_PROTOCOL_VERSION, withDeepResearchProtocol } from '../deepResearch'

describe('deep research runtime protocol', () => {
  it('leaves ordinary messages unchanged', () => {
    expect(withDeepResearchProtocol('Summarize this note', false)).toBe('Summarize this note')
    expect(withDeepResearchProtocol('Summarize this note')).toBe('Summarize this note')
  })

  it('adds a bounded, cited research task protocol', () => {
    const result = withDeepResearchProtocol('Research the personal AI assistant market', true, {
      task_id: 'task-1',
      action: 'plan'
    })

    expect(result).toContain(`<zen-deep-research version="${DEEP_RESEARCH_PROTOCOL_VERSION}"`)
    expect(result).toContain('task-id="task-1" action="plan"')
    expect(result).toContain('3-5 bounded research questions')
    expect(result).toContain('evidence matrix')
    expect(result).toContain('clickable source URLs')
    expect(result).toContain('no more than two focused follow-up passes')
    expect(result).toContain('does not imply a file export')
    expect(result).toContain('如果需要，我可以把以上结果整理为 Word、PPT 或 PDF')
    expect(result).toContain('Do not rerun the research')
  })

  it('does not append the protocol twice', () => {
    const task = { task_id: 'task-1', action: 'plan' as const }
    const once = withDeepResearchProtocol('Research the market', true, task)
    const twice = withDeepResearchProtocol(once, true, task)

    expect(twice).toBe(once)
    expect(twice.match(/<zen-deep-research version=/g)).toHaveLength(1)
  })

  it('continues a confirmed task without asking for another plan', () => {
    const result = withDeepResearchProtocol('Proceed', false, {
      task_id: 'task-1',
      action: 'start'
    })

    expect(result).toContain('action="start"')
    expect(result).toContain('Do not ask for confirmation again')
    expect(result).toContain('latest plan and constraints')
  })

  it('can start a newly armed task immediately without requiring an earlier plan', () => {
    const result = withDeepResearchProtocol('Start immediately', true, {
      task_id: 'task-2',
      action: 'start'
    })

    expect(result).toContain('start this new research Task immediately')
    expect(result).toContain('Briefly state the bounded plan')
    expect(result).not.toContain('latest plan and constraints')
  })

  it('revises an existing plan without starting broad research', () => {
    const result = withDeepResearchProtocol('Focus on China', false, {
      task_id: 'task-1',
      action: 'revise'
    })

    expect(result).toContain('action="revise"')
    expect(result).toContain('Return the complete revised plan')
    expect(result).toContain('Do not start broad research yet')
  })
})
