import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import useScrollPosition from '../useScrollPosition'

let positions: Map<string, unknown>
beforeEach(() => {
  vi.useFakeTimers()
  positions = new Map()
  Object.assign(window, {
    keyv: {
      get: (key: string) => positions.get(key),
      set: vi.fn((key: string, value: number) => positions.set(key, value))
    }
  })
})
afterEach(() => vi.useRealTimers())

describe('conversation scroll position', () => {
  it('flushes the last scroll before unmount even inside the throttle window', () => {
    const { result, unmount } = renderHook(() => useScrollPosition('one', 100, false))
    const node = document.createElement('div')
    result.current.containerRef.current = node
    node.scrollTop = -100
    act(() => result.current.handleScroll())
    node.scrollTop = -731
    act(() => result.current.handleScroll())
    unmount()
    expect(positions.get('scroll:one')).toBe(-731)
  })

  it('cannot write a previous conversation position under a new key', () => {
    positions.set('scroll:two', -200)
    const { result, rerender } = renderHook(({ id }) => useScrollPosition(id, 100, false), {
      initialProps: { id: 'one' }
    })
    const node = document.createElement('div')
    result.current.containerRef.current = node
    node.scrollTop = -100
    act(() => result.current.handleScroll())
    node.scrollTop = -800
    act(() => result.current.handleScroll())
    rerender({ id: 'two' })
    node.scrollTop = 0
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(positions.get('scroll:one')).toBe(-800)
    expect(result.current.getStoredPosition()).toBe(-200)
    expect(positions.get('scroll:two')).toBe(-200)
  })

  it.each([undefined, null, '', 'invalid', Number.NaN])('treats %s as no saved position', (raw) => {
    positions.set('scroll:one', raw)
    const { result } = renderHook(() => useScrollPosition('one', undefined, false))
    expect(result.current.getStoredPosition()).toBeNull()
  })

  it.each([0, -900, '-350'])('restores a valid position %s', (raw) => {
    positions.set('scroll:one', raw)
    const { result } = renderHook(() => useScrollPosition('one', undefined, false))
    const node = document.createElement('div')
    node.scrollTo = vi.fn()
    result.current.containerRef.current = node
    act(() => result.current.restorePosition())
    expect(node.scrollTo).toHaveBeenCalledWith({ top: Number(raw) })
  })
})
