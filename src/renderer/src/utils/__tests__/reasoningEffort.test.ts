import { describe, expect, it } from 'vitest'

import {
  AGENT_REASONING_EFFORT_OPTIONS,
  CHAT_REASONING_EFFORT_OPTIONS,
  normalizeChatReasoningEffort,
  toAgentEffort
} from '../reasoningEffort'

describe('reasoning effort UI policy', () => {
  it('exposes the five chat levels in product order', () => {
    expect(CHAT_REASONING_EFFORT_OPTIONS).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
  })

  it('exposes the four agent levels in product order', () => {
    expect(AGENT_REASONING_EFFORT_OPTIONS).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('normalizes legacy chat values to the new defaults', () => {
    expect(normalizeChatReasoningEffort()).toBe('medium')
    expect(normalizeChatReasoningEffort('default')).toBe('medium')
    expect(normalizeChatReasoningEffort('auto')).toBe('medium')
    expect(normalizeChatReasoningEffort('minimal')).toBe('low')
  })

  it('maps extra-high agent effort to the protocol max value', () => {
    expect(toAgentEffort('low')).toBe('low')
    expect(toAgentEffort('medium')).toBe('medium')
    expect(toAgentEffort('high')).toBe('high')
    expect(toAgentEffort('xhigh')).toBe('max')
  })
})
