import { describe, expect, it } from 'vitest'

import {
  canCreateAgentSession,
  DEFAULT_DSH_AGENT_ID,
  DEFAULT_FUSION_AGENT_ID,
  DEFAULT_OPENCODE_AGENT_ID
} from '../config/agents'
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

  it.each([DEFAULT_OPENCODE_AGENT_ID, DEFAULT_DSH_AGENT_ID])(
    'allows the native assistant identity %s without changing runtime selection or the main-process preview gate',
    (agentId) => {
      expect(isAssistantExecutionAllowed(agentId)).toBe(true)
      expect(canCreateAgentSession(agentId)).toBe(true)
      expect(() => assertAssistantExecutionAllowed(agentId)).not.toThrow()
    }
  )
})
