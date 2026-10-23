import { describe, expect, it } from 'vitest'

import { inputSizingPolicy, sizeInput } from '../input-sizing'

describe('explicit input preflight policies, not byte counts disguised as actual tokens', () => {
  it('preserves strict defaults for existing configurations and the explicitly approved deep estimate', () => {
    expect(inputSizingPolicy({})).toBe('utf8-bytes')
    expect(inputSizingPolicy({ execution: { inputSizing: 'estimated-tokens' } })).toBe('estimated-tokens')
    expect(
      inputSizingPolicy({
        execution: { inputSizing: 'estimated-tokens' },
        deep: { acknowledgedApproximateInputSizing: true }
      })
    ).toBe('deep-estimate')
  })

  it('admits a realistic CJK request under its token reserve without hiding text or tool history', () => {
    const serialized = JSON.stringify({ messages: [{ role: 'user', content: '合成资料'.repeat(12000) }], tools: [] })
    const options = { requestBytes: Buffer.byteLength(serialized) + 20, imageTokens: 8192, maxInputTokens: 128000 }
    const strict = sizeInput(serialized, { ...options, strategy: 'utf8-bytes' })
    const estimate = sizeInput(serialized, { ...options, strategy: 'estimated-tokens' })
    expect(strict.estimatedInputTokens).toBeGreaterThan(options.maxInputTokens)
    expect(estimate.estimatedInputTokens).toBeLessThan(options.maxInputTokens)
    expect(estimate.safetyMultiplier).toBe(2)
    expect(estimate.estimatedInputTokens).toBe(estimate.approximateTokens * 2 + 8192 + 4096)
    expect(estimate.requestBytes).toBe(options.requestBytes)
    expect(estimate.textAndToolsBytes).toBe(Buffer.byteLength(serialized))
    expect(JSON.stringify(estimate)).not.toContain('合成资料')
  })

  it('retains overhead and per-request image reservation even for small text and tool schemas', () => {
    const noTools = sizeInput('{"messages":[]}', {
      strategy: 'estimated-tokens',
      requestBytes: 100,
      imageTokens: 8192,
      maxInputTokens: 128000
    })
    const tools = sizeInput(JSON.stringify({ tools: [{ description: '合成工具'.repeat(1000) }] }), {
      strategy: 'estimated-tokens',
      requestBytes: 14000,
      imageTokens: 8192,
      maxInputTokens: 128000
    })
    expect(noTools.estimatedInputTokens).toBeGreaterThan(8192 + 4096)
    expect(tools.estimatedInputTokens).toBeGreaterThan(noTools.estimatedInputTokens)
  })
})
