import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ImageToolbar from '../ImageToolbar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('../ImageToolButton', () => ({
  default: ({ tooltip, onClick, icon }: any) => (
    <button type="button" onClick={onClick} aria-label={tooltip}>
      {icon}
    </button>
  )
}))

vi.mock('lucide-react', () => ({
  ChevronUp: () => <span data-testid="chevron-up">up</span>,
  ChevronDown: () => <span data-testid="chevron-down">down</span>,
  ChevronLeft: () => <span data-testid="chevron-left">left</span>,
  ChevronRight: () => <span data-testid="chevron-right">right</span>,
  ZoomIn: () => <span data-testid="zoom-in">+</span>,
  ZoomOut: () => <span data-testid="zoom-out">-</span>,
  Scan: () => <span data-testid="scan">scan</span>
}))

vi.mock('@renderer/components/Icons', () => ({
  ResetIcon: () => <span data-testid="reset">reset</span>
}))

vi.mock('@renderer/utils', () => ({
  classNames: (...args: any[]) => args.filter(Boolean).join(' ')
}))

describe('ImageToolbar', () => {
  const pan = vi.fn()
  const zoom = vi.fn()
  const dialog = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders toolbar controls', () => {
    render(<ImageToolbar pan={pan} zoom={zoom} dialog={dialog} />)

    expect(screen.getByRole('toolbar', { name: 'preview.label' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'preview.reset' })).toBeInTheDocument()
  })

  it('calls pan handlers with the expected deltas', () => {
    render(<ImageToolbar pan={pan} zoom={zoom} dialog={dialog} />)

    fireEvent.click(screen.getByRole('button', { name: 'preview.pan_up' }))
    fireEvent.click(screen.getByRole('button', { name: 'preview.pan_down' }))
    fireEvent.click(screen.getByRole('button', { name: 'preview.pan_left' }))
    fireEvent.click(screen.getByRole('button', { name: 'preview.pan_right' }))

    expect(pan).toHaveBeenNthCalledWith(1, 0, -20)
    expect(pan).toHaveBeenNthCalledWith(2, 0, 20)
    expect(pan).toHaveBeenNthCalledWith(3, -20, 0)
    expect(pan).toHaveBeenNthCalledWith(4, 20, 0)
  })

  it('calls zoom and reset handlers', () => {
    render(<ImageToolbar pan={pan} zoom={zoom} dialog={dialog} />)

    fireEvent.click(screen.getByRole('button', { name: 'preview.zoom_in' }))
    fireEvent.click(screen.getByRole('button', { name: 'preview.zoom_out' }))
    fireEvent.click(screen.getByRole('button', { name: 'preview.reset' }))

    expect(zoom).toHaveBeenCalledWith(0.1)
    expect(zoom).toHaveBeenCalledWith(-0.1)
    expect(pan).toHaveBeenCalledWith(0, 0, true)
    expect(zoom).toHaveBeenCalledWith(1, true)
  })

  it('opens the dialog when requested', () => {
    render(<ImageToolbar pan={pan} zoom={zoom} dialog={dialog} />)

    fireEvent.click(screen.getByRole('button', { name: 'preview.dialog' }))

    expect(dialog).toHaveBeenCalled()
  })
})
