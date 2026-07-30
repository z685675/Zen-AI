import { describe, expect, it } from 'vitest'

import { isApiModelCompatibleWithAgentRuntime } from '../agentSession'

describe('isApiModelCompatibleWithAgentRuntime', () => {
  it('keeps every configured model selectable in Auto mode', () => {
    expect(
      isApiModelCompatibleWithAgentRuntime(
        {
          provider_type: 'openai',
          endpoint_type: 'openai',
          agent_runtime_compatibility: ['codex']
        },
        'auto'
      )
    ).toBe(true)
  })

  it('honors explicit backend capability metadata for developer overrides', () => {
    const model = {
      provider_type: 'openai',
      endpoint_type: 'openai' as const,
      agent_runtime_compatibility: ['codex'] as const
    }

    expect(isApiModelCompatibleWithAgentRuntime(model, 'codex')).toBe(true)
    expect(isApiModelCompatibleWithAgentRuntime(model, 'claude-code')).toBe(false)
  })

  it('treats missing capability metadata as unverified instead of unsupported', () => {
    expect(
      isApiModelCompatibleWithAgentRuntime(
        {
          provider_type: 'openai'
        },
        'claude-code'
      )
    ).toBe(true)
  })
})
