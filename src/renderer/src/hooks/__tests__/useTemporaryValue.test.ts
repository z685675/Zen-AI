import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTemporaryValue } from '../useTemporaryValue'

describe('useTemporaryValue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the default value initially', () => {
    const { result } = renderHook(() => useTemporaryValue('default'))

    expect(result.current[0]).toBe('default')
  })

  it('temporarily updates and then resets the value', () => {
    const { result } = renderHook(() => useTemporaryValue('default', 1000))

    act(() => {
      result.current[1]('temporary')
    })

    expect(result.current[0]).toBe('temporary')

    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(result.current[0]).toBe('default')
  })

  it('clears the previous timer when called repeatedly', () => {
    const { result } = renderHook(() => useTemporaryValue('default', 1000))

    act(() => {
      result.current[1]('first')
    })
    act(() => {
      vi.advanceTimersByTime(500)
      result.current[1]('second')
    })

    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(result.current[0]).toBe('second')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current[0]).toBe('default')
  })

  it('supports different value types', () => {
    const { result } = renderHook(() => useTemporaryValue<{ ok: boolean } | null>(null, 1000))

    act(() => {
      result.current[1]({ ok: true })
    })
    expect(result.current[0]).toEqual({ ok: true })

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current[0]).toBeNull()
  })
})
