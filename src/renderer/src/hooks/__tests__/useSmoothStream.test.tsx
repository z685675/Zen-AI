import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSmoothStream } from '../useSmoothStream'

describe('useSmoothStream', () => {
  let callbacks: FrameRequestCallback[]

  beforeEach(() => {
    callbacks = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback)
        return callbacks.length
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const flushFrame = (time = 20) => {
    const callback = callbacks.shift()
    expect(callback).toBeDefined()
    act(() => callback?.(time))
  }

  it('does not poll animation frames while the stream is idle', () => {
    const onUpdate = vi.fn()
    renderHook(() => useSmoothStream({ onUpdate, streamDone: false }))

    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('starts rendering when a chunk arrives and stops after draining the queue', () => {
    const onUpdate = vi.fn()
    const { result } = renderHook(() => useSmoothStream({ onUpdate, streamDone: false, minDelay: 0 }))

    act(() => result.current.addChunk('hello'))
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)

    while (callbacks.length > 0) {
      flushFrame()
    }

    expect(onUpdate).toHaveBeenLastCalledWith('hello')
    expect(callbacks).toHaveLength(0)
  })

  it('flushes queued text when the stream completes', () => {
    const onUpdate = vi.fn()
    const { result, rerender } = renderHook(
      ({ done }) => useSmoothStream({ onUpdate, streamDone: done, minDelay: 1000 }),
      { initialProps: { done: false } }
    )

    act(() => result.current.addChunk('completed response'))
    rerender({ done: true })
    flushFrame()

    expect(onUpdate).toHaveBeenLastCalledWith('completed response')
    expect(callbacks).toHaveLength(0)
  })
})
