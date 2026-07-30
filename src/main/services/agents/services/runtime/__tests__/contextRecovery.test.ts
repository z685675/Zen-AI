import { describe, expect, it } from 'vitest'

import { isRecoverableAgentContextError, withAgentRecoveryContext } from '../contextRecovery'

describe('agent runtime context recovery', () => {
  it('recognizes missing sessions and context-capacity failures', () => {
    expect(isRecoverableAgentContextError(new Error('thread/resume failed: no rollout found for thread id'))).toBe(true)
    expect(isRecoverableAgentContextError(new Error('context_length_exceeded'))).toBe(true)
    expect(isRecoverableAgentContextError(new Error('invalid API key'))).toBe(false)
  })

  it('wraps local history as untrusted recovery context and keeps the current request last', () => {
    const result = withAgentRecoveryContext('继续完成报告', '用户最早确认的编号是 ZEN-2048')

    expect(result).toContain('<recovered-context>')
    expect(result).toContain('ZEN-2048')
    expect(result).toContain('## Current User Request\n继续完成报告')
  })

  it('does not change the prompt when no recovery context exists', () => {
    expect(withAgentRecoveryContext('正常请求')).toBe('正常请求')
  })
})
