import { describe, expect, it } from 'vitest'

import { buildClaudeThinkingOptions } from '../thinking'

describe('buildClaudeThinkingOptions', () => {
  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['max', 'max']
  ] as const)('preserves %s effort for protocol-bridged models', (effort, expected) => {
    expect(
      buildClaudeThinkingOptions({
        thinkingOptions: { effort, thinking: { type: 'enabled', budgetTokens: 4096 } },
        useProtocolBridge: true,
        modelId: 'gpt-5.6-luna'
      })
    ).toEqual({ thinking: { type: 'adaptive' }, effort: expected })
  })

  it('uses adaptive effort for non-Claude models on direct Anthropic-compatible endpoints', () => {
    expect(
      buildClaudeThinkingOptions({
        thinkingOptions: { effort: 'high', thinking: { type: 'enabled', budgetTokens: 8192 } },
        useProtocolBridge: false,
        modelId: 'gemini-3-flash-preview'
      })
    ).toEqual({ thinking: { type: 'adaptive' }, effort: 'high' })
  })

  it('keeps token-budget thinking for older Claude models', () => {
    expect(
      buildClaudeThinkingOptions({
        thinkingOptions: { effort: 'high', thinking: { type: 'enabled', budgetTokens: 8192 } },
        useProtocolBridge: false,
        modelId: 'claude-sonnet-4-5'
      })
    ).toEqual({ thinking: { type: 'enabled', budgetTokens: 8192 } })
  })

  it('preserves adaptive max effort for Claude 4.6', () => {
    expect(
      buildClaudeThinkingOptions({
        thinkingOptions: { effort: 'max', thinking: { type: 'adaptive' } },
        useProtocolBridge: false,
        modelId: 'claude-opus-4-6'
      })
    ).toEqual({ thinking: { type: 'adaptive' }, effort: 'max' })
  })
})
