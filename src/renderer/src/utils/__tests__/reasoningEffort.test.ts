import { describe, expect, it } from 'vitest'

import {
  AGENT_DEFAULT_REASONING_EFFORT,
  AGENT_REASONING_EFFORT_OPTIONS,
  CHAT_REASONING_EFFORT_OPTIONS,
  normalizeAgentReasoningEffort,
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

  it('defaults every unset or legacy value to medium', () => {
    expect(AGENT_DEFAULT_REASONING_EFFORT).toBe('medium')
    expect(normalizeAgentReasoningEffort()).toBe('medium')
    expect(normalizeAgentReasoningEffort('default')).toBe('medium')
    expect(normalizeAgentReasoningEffort('auto')).toBe('medium')
    expect(normalizeAgentReasoningEffort('none')).toBe('medium')
  })

  it('preserves a supported manual selection', () => {
    expect(normalizeAgentReasoningEffort('low')).toBe('low')
    expect(normalizeAgentReasoningEffort('medium')).toBe('medium')
    expect(normalizeAgentReasoningEffort('high')).toBe('high')
    expect(normalizeAgentReasoningEffort('xhigh')).toBe('xhigh')
  })

  it('sends the medium default to the agent runtime', () => {
    expect(toAgentEffort(normalizeAgentReasoningEffort())).toBe('medium')
  })
})
