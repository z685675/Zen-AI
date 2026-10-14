import { describe, expect, it } from 'vitest'

import {
  DEFAULT_AGENT_AVATAR,
  DEFAULT_FUSION_AGENT_ID,
  DEFAULT_FUSION_AGENT_NAME,
  DEFAULT_OPENCODE_AGENT_ID,
  DEFAULT_OPENCODE_AGENT_NAME,
  getAgentAvatar
} from './agents'

describe('assistant display identity', () => {
  it('uses the managed name and red heart for the OpenCode assistant, including old saved avatars', () => {
    expect(DEFAULT_OPENCODE_AGENT_NAME).toBe('智能助手')
    expect(getAgentAvatar(DEFAULT_OPENCODE_AGENT_ID)).toBe('❤️')
    expect(getAgentAvatar(DEFAULT_OPENCODE_AGENT_ID, '🩶')).toBe('❤️')
  })

  it('preserves the legacy and other agent avatar rules', () => {
    expect(DEFAULT_FUSION_AGENT_NAME).toBe('请弃用旧助手')
    expect(getAgentAvatar(DEFAULT_FUSION_AGENT_ID)).toBe('❤️')
    expect(getAgentAvatar('custom')).toBe(DEFAULT_AGENT_AVATAR)
    expect(getAgentAvatar(undefined)).toBe(DEFAULT_AGENT_AVATAR)
  })
})
