import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useCallback, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAnchoredPanel } from '../QuickPanel/useAnchoredPanel'

let buttonRect: DOMRect
let viewportWidth = 1024
let viewportHeight = 768

function Fixture() {
  const [anchor, setAnchor] = useState<HTMLElement>()
  const [visible, setVisible] = useState(false)
  const [showButton, setShowButton] = useState(true)
  const floatingRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setVisible(false), [])
  const style = useAnchoredPanel(anchor, floatingRef, visible, close)
  return (
    <>
      {showButton && (
        <button
          type="button"
          data-testid="anchor"
          onClick={(event) => {
            setAnchor(event.currentTarget)
            setVisible(true)
          }}>
          Open
        </button>
      )}
      <button type="button" onClick={() => setShowButton(false)}>
        Remove anchor
      </button>
      <div ref={floatingRef} data-testid="floating" style={{ position: 'fixed', width: 200, height: 100, ...style }} />
      <span data-testid="visible">{String(visible)}</span>
    </>
  )
}

describe('button-anchored quick panel geometry', () => {
  beforeEach(() => {
    buttonRect = new DOMRect(300, 500, 120, 34)
    viewportWidth = 1024
    viewportHeight = 768
    const original = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.dataset.testid === 'anchor') return this.isConnected ? buttonRect : new DOMRect()
      return original.call(this)
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () {
      return this.dataset.testid === 'floating' ? 200 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
      return this.dataset.testid === 'floating' ? 100 : 0
    })
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockImplementation(() => viewportWidth)
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockImplementation(() => viewportHeight)
  })

  afterEach(() => vi.restoreAllMocks())

  it('stays eight pixels above the button after editor layout movement and scrolling', async () => {
    render(<Fixture />)
    fireEvent.click(screen.getByTestId('anchor'))
    const panel = screen.getByTestId('floating')
    await waitFor(() => expect(panel).toHaveStyle({ left: '300px', top: '392px' }))
    buttonRect = new DOMRect(160, 640, 120, 34)
    fireEvent.scroll(window)
    await waitFor(() => expect(panel).toHaveStyle({ left: '160px', top: '532px' }))
  })

  it('flips below a button near the top and stays inside a narrower viewport', async () => {
    buttonRect = new DOMRect(900, 20, 120, 34)
    render(<Fixture />)
    fireEvent.click(screen.getByTestId('anchor'))
    const panel = screen.getByTestId('floating')
    await waitFor(() => expect(panel).toHaveStyle({ left: '816px', top: '62px' }))
    viewportWidth = 640
    buttonRect = new DOMRect(520, 20, 100, 34)
    fireEvent.resize(window)
    await waitFor(() => {
      expect(panel).toHaveStyle({ top: '62px' })
      expect(Number.parseFloat(panel.style.left)).toBeGreaterThanOrEqual(8)
      expect(Number.parseFloat(panel.style.left) + 200).toBeLessThanOrEqual(viewportWidth - 8)
    })
  })

  it('closes when its button is removed instead of retaining a stale screen position', async () => {
    render(<Fixture />)
    const button = screen.getByTestId('anchor')
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByTestId('floating')).toHaveStyle({ top: '392px' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove anchor' }))
    })
    fireEvent.resize(window)
    await waitFor(() => expect(screen.getByTestId('visible')).toHaveTextContent('false'))
  })
})
