import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import NativeMessageActions from '../NativeMessageActions'

describe('new assistant answer actions', () => {
  it('offers continuation separately from regeneration', () => {
    const onContinue = vi.fn(),
      onRetry = vi.fn()
    render(
      <NativeMessageActions
        busy={false}
        onContinue={onContinue}
        onRetry={onRetry}
        onFork={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'assistantTaskContinuation.action' }))
    expect(onContinue).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })
  it('renders all three real buttons and invokes their corresponding operations', () => {
    const onRetry = vi.fn(),
      onFork = vi.fn(),
      onDelete = vi.fn()
    render(<NativeMessageActions busy={false} onRetry={onRetry} onFork={onFork} onDelete={onDelete} />)
    fireEvent.click(screen.getByRole('button', { name: 'common.regenerate' }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.message.new.branch.tooltip' }))
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onFork).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledOnce()
  })
  it('disables history changes while the task or another history operation is running', () => {
    const operation = vi.fn()
    render(<NativeMessageActions busy onRetry={operation} onFork={operation} onDelete={operation} />)
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    expect(operation).not.toHaveBeenCalled()
  })
})
