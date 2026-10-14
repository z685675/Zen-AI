import { CacheService } from '@renderer/services/CacheService'
import { beforeEach, describe, expect, it } from 'vitest'

import { consumeAgentEntrySelection, markAgentEntrySelection } from '../agentEntrySelection'

beforeEach(() => CacheService.clear())
describe('explicit cross-workspace navigation', () => {
  it('protects the selected snapshot once, without changing ordinary latest-session restore', () => {
    const target = { agentId: 'new', sessionId: 'copy' }
    expect(consumeAgentEntrySelection('opencode', target)).toBe(false)
    markAgentEntrySelection('opencode', target)
    expect(consumeAgentEntrySelection('legacy', target)).toBe(false)
    expect(consumeAgentEntrySelection('opencode', { ...target, sessionId: 'other' })).toBe(false)
    expect(consumeAgentEntrySelection('opencode', target)).toBe(true)
    expect(consumeAgentEntrySelection('opencode', target)).toBe(false)
  })
})
