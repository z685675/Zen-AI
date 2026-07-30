import type { TextStreamPart } from 'ai'
import { describe, expect, it } from 'vitest'

import { AgentRuntimeNoOutputTimeoutError, isRuntimeBootstrapChunk, shouldFallbackRuntime } from '../fallback'

describe('runtime fallback guards', () => {
  it('allows a pre-output protocol failure to try one Auto fallback', () => {
    expect(shouldFallbackRuntime(new Error('404: /v1/messages is unsupported'), new AbortController())).toBe(true)
    expect(
      shouldFallbackRuntime(
        new Error('Agent runtime completed before producing a user-visible result'),
        new AbortController()
      )
    ).toBe(true)
    expect(
      shouldFallbackRuntime(
        new AgentRuntimeNoOutputTimeoutError('The runtime started but produced no visible output'),
        new AbortController()
      )
    ).toBe(true)
  })

  it('does not hide authentication, network, quota, or cancellation errors', () => {
    const errors = [
      new Error('401 unauthorized'),
      new Error('API key is invalid'),
      new Error('429 rate limit exceeded'),
      new Error('network socket disconnected'),
      Object.assign(new Error('cancelled'), { name: 'AbortError' })
    ]

    for (const error of errors) {
      expect(shouldFallbackRuntime(error, new AbortController())).toBe(false)
    }
  })

  it('treats runtime init markers as buffered bootstrap chunks', () => {
    const chunks = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'raw', rawValue: { type: 'init' } },
      { type: 'raw', rawValue: { type: 'codex_thread_started' } }
    ] as TextStreamPart<Record<string, any>>[]

    for (const chunk of chunks) {
      expect(isRuntimeBootstrapChunk(chunk)).toBe(true)
    }
    expect(isRuntimeBootstrapChunk({ type: 'text-start', id: 'text-1' })).toBe(false)
  })
})
