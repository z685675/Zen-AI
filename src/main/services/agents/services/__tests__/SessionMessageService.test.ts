import { describe, expect, it } from 'vitest'

import { findCompatibleAgentSessionId } from '../runtime/resume'

function persistedAssistant(params: {
  agentSessionId: string
  model: { provider: string; id: string }
  status: 'success' | 'error'
}) {
  return {
    agent_session_id: params.agentSessionId,
    content: JSON.stringify({
      message: {
        role: 'assistant',
        model: params.model,
        status: params.status
      }
    })
  }
}

describe('SessionMessageService runtime-safe resume', () => {
  it('does not reuse a failed GPT message that inherited a Claude thread ID', () => {
    const rows = [
      persistedAssistant({
        agentSessionId: 'claude-thread-id',
        model: { provider: 'zen', id: 'gpt-5.4-mini' },
        status: 'error'
      }),
      persistedAssistant({
        agentSessionId: 'claude-thread-id',
        model: { provider: 'zen', id: 'claude-opus-4-6' },
        status: 'success'
      })
    ]

    expect(findCompatibleAgentSessionId(rows, 'zen:gpt-5.4-mini')).toBe('')
  })

  it('reuses the latest successful thread only when its provider and model match', () => {
    const rows = [
      persistedAssistant({
        agentSessionId: 'fresh-codex-thread',
        model: { provider: 'zen', id: 'gpt-5.6-luna' },
        status: 'success'
      }),
      persistedAssistant({
        agentSessionId: 'older-thread',
        model: { provider: 'zen', id: 'gpt-5.4-mini' },
        status: 'success'
      })
    ]

    expect(findCompatibleAgentSessionId(rows, 'zen:gpt-5.6-luna')).toBe('fresh-codex-thread')
  })
})
