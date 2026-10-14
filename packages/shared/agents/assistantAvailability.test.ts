import { describe, expect, it } from 'vitest'

import { canCreateAgentSession, DEFAULT_FUSION_AGENT_ID, DEFAULT_OPENCODE_AGENT_ID } from '../config/agents'
import {
  assertAssistantExecutionAllowed,
  isAssistantExecutionAllowed,
  LEGACY_ASSISTANT_READ_ONLY_CODE
} from './assistantAvailability'

describe('assistant execution product boundary', () => {
  it.each([DEFAULT_FUSION_AGENT_ID, 'custom-legacy-agent', undefined, null])('keeps %s view-only', (agentId) => {
    expect(isAssistantExecutionAllowed(agentId)).toBe(false)
    expect(canCreateAgentSession(agentId)).toBe(false)
    expect(() => assertAssistantExecutionAllowed(agentId)).toThrowError(
      expect.objectContaining({ code: LEGACY_ASSISTANT_READ_ONLY_CODE })
    )
  })

  it('allows the new assistant without changing its runtime selection', () => {
    expect(isAssistantExecutionAllowed(DEFAULT_OPENCODE_AGENT_ID)).toBe(true)
    expect(canCreateAgentSession(DEFAULT_OPENCODE_AGENT_ID)).toBe(true)
    expect(() => assertAssistantExecutionAllowed(DEFAULT_OPENCODE_AGENT_ID)).not.toThrow()
  })
})
