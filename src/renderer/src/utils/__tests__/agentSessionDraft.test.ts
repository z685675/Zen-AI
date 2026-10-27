import { CacheService } from '@renderer/services/CacheService'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearAgentSessionDraft,
  getAgentSessionDraft,
  getAgentSessionDraftCacheKey,
  saveAgentSessionDraft
} from '../agentSessionDraft'
import { shouldDiscardEmptyConversation } from '../conversationDraft'

beforeEach(() => {
  CacheService.clear()
  localStorage.clear()
  vi.restoreAllMocks()
})

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

describe('session draft retention', () => {
  it('keeps exact text per conversation after the in-memory cache is lost', () => {
    saveAgentSessionDraft('agent', 'one', '第一份草稿\n未发送  ')
    saveAgentSessionDraft('agent', 'two', '第二份草稿')
    CacheService.clear()
    expect(getAgentSessionDraft('agent', 'one')).toBe('第一份草稿\n未发送  ')
    expect(getAgentSessionDraft('agent', 'two')).toBe('第二份草稿')
    expect(getAgentSessionDraft('other', 'one')).toBe('')
  })

  it('protects a draft-only conversation from empty-session cleanup after cache expiry', () => {
    saveAgentSessionDraft('agent', 'one', '请帮我整理项目资料')
    CacheService.clear()
    expect(
      shouldDiscardEmptyConversation({
        draft: getAgentSessionDraft('agent', 'one'),
        messageCount: 0,
        isLoading: false
      })
    ).toBe(false)
  })

  it('clears sent or deleted drafts from both storage layers', () => {
    saveAgentSessionDraft('agent', 'sent', '已发送')
    saveAgentSessionDraft('agent', 'deleted', '已删除')
    saveAgentSessionDraft('agent', 'sent', '')
    clearAgentSessionDraft('agent', 'deleted')
    CacheService.clear()
    expect(getAgentSessionDraft('agent', 'sent')).toBe('')
    expect(getAgentSessionDraft('agent', 'deleted')).toBe('')
    expect(localStorage.length).toBe(0)
  })

  it('retains live input when local storage cannot be written or read', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    saveAgentSessionDraft('agent', 'one', '仍保留在本次应用中')
    expect(getAgentSessionDraft('agent', 'one')).toBe('仍保留在本次应用中')
    expect(getAgentSessionDraft('agent', 'missing')).toBe('')
  })
})
