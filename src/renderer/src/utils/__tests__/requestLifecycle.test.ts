import { afterEach, describe, expect, it } from 'vitest'

import { abortCompletion, abortMap } from '../abortController'
import { createRequestLifecycle } from '../requestLifecycle'

afterEach(() => {
  abortMap.clear()
})

describe('request lifecycle', () => {
  it('registers and removes the Stop action callback', () => {
    const lifecycle = createRequestLifecycle('assistant-1', 'user-1')

    expect(lifecycle.isActive()).toBe(true)
    expect(abortMap.get('user-1')).toHaveLength(1)

    lifecycle.dispose()

    expect(lifecycle.isActive()).toBe(false)
    expect(abortMap.get('user-1')).toEqual([])
  })

  it('invalidates an older request without removing the newer request', () => {
    const previous = createRequestLifecycle('assistant-1', 'user-1')
    const current = createRequestLifecycle('assistant-1', 'user-1')

    expect(previous.isActive()).toBe(false)
    expect(current.isActive()).toBe(true)

    previous.dispose()
    expect(current.isActive()).toBe(true)
    expect(abortMap.get('user-1')).toHaveLength(1)

    current.dispose()
  })

  it('aborts through the existing user-message stop action', () => {
    const lifecycle = createRequestLifecycle('assistant-1', 'user-1')

    abortCompletion('user-1')

    expect(lifecycle.signal.aborted).toBe(true)
    expect(lifecycle.isActive()).toBe(false)
    expect(lifecycle.isCurrent()).toBe(true)
    lifecycle.dispose()
  })
})
