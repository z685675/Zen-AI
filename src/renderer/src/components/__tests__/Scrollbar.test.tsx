import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import Scrollbar from '../Scrollbar'

vi.mock('lodash', async () => {
  const actual = await import('lodash')
  return {
    ...actual,
    throttle: vi.fn((fn) => {
      const throttled = (...args: any[]) => fn(...args)
      throttled.cancel = vi.fn()
      return throttled
    })
  }
})

describe('Scrollbar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('renders children and forwards props', () => {
    render(
      <Scrollbar data-testid="scrollbar" className="custom-class">
        <div data-testid="child">content</div>
      </Scrollbar>
    )

    expect(screen.getByTestId('child').textContent).toBe('content')
    expect(screen.getByTestId('scrollbar').className).toContain('custom-class')
  })

  it('matches the default snapshot', () => {
    const { container } = render(<Scrollbar data-testid="scrollbar">content</Scrollbar>)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('handles scroll activity and timeout reset without crashing', () => {
    render(<Scrollbar data-testid="scrollbar">content</Scrollbar>)
    const scrollbar = screen.getByTestId('scrollbar')

    fireEvent.scroll(scrollbar)
    act(() => {
      vi.advanceTimersByTime(800)
    })
    fireEvent.scroll(scrollbar)
    act(() => {
      vi.advanceTimersByTime(1600)
    })

    expect(scrollbar).toBeDefined()
  })

  it('uses throttle and cancels it on unmount', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    const { throttle } = await import('lodash')

    const { unmount } = render(<Scrollbar data-testid="scrollbar">content</Scrollbar>)
    const scrollbar = screen.getByTestId('scrollbar')
    fireEvent.scroll(scrollbar)

    expect(throttle).toHaveBeenCalledWith(expect.any(Function), 100, { leading: true, trailing: true })

    unmount()

    const throttledFunction = (throttle as unknown as Mock).mock.results[0].value
    expect(clearTimeoutSpy).toHaveBeenCalled()
    expect(throttledFunction.cancel).toHaveBeenCalled()
  })

  it('forwards refs', () => {
    const ref = { current: null as HTMLDivElement | null }
    render(
      <Scrollbar data-testid="scrollbar" ref={ref}>
        content
      </Scrollbar>
    )

    expect(ref.current).not.toBeNull()
  })
})
