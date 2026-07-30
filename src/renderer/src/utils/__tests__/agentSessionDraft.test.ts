import { describe, expect, it } from 'vitest'

import { getAgentSessionDraftCacheKey } from '../agentSessionDraft'

describe('getAgentSessionDraftCacheKey', () => {
  it('isolates drafts between sessions of the same agent', () => {
    expect(getAgentSessionDraftCacheKey('agent-1', 'session-1')).not.toBe(
      getAgentSessionDraftCacheKey('agent-1', 'session-2')
    )
  })

  it('isolates drafts between agents and safely encodes identifiers', () => {
    expect(getAgentSessionDraftCacheKey('agent:1', 'session/1')).toBe('agent-session-draft:agent%3A1:session%2F1')
    expect(getAgentSessionDraftCacheKey('agent-1', 'session/1')).not.toBe(
      getAgentSessionDraftCacheKey('agent-2', 'session/1')
    )
  })
})
