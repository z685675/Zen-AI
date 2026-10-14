import { DEFAULT_FUSION_AGENT_ID, DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { describe, expect, it } from 'vitest'

import { canUseLegacyMessageAction, isReadOnlyLegacySession } from '../legacyMessageActions'

describe('read-only imported SDK history', () => {
  it('locks old agent sessions but not ordinary AI chats or native new-assistant messages', () => {
    expect(isReadOnlyLegacySession('agent-session:old', DEFAULT_FUSION_AGENT_ID)).toBe(true)
    expect(isReadOnlyLegacySession('agent-session:old', 'custom-agent')).toBe(true)
    expect(isReadOnlyLegacySession('agent-session:new', DEFAULT_OPENCODE_AGENT_ID)).toBe(false)
    expect(isReadOnlyLegacySession('normal-chat', 'chat-assistant')).toBe(false)
  })
  it.each(['copy', 'more-menu', 'notes', 'trace', 'inspect-data'])('allows viewing/export action %s', (action) => {
    expect(canUseLegacyMessageAction(action)).toBe(true)
  })
  it.each([
    'user-edit',
    'user-regenerate',
    'assistant-regenerate',
    'new-branch',
    'delete',
    'translate',
    'future-action'
  ])('blocks mutation or unknown action %s', (action) => {
    expect(canUseLegacyMessageAction(action)).toBe(false)
  })
})
