import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === 'assistant_transition.legacy_read_only' ? '旧助手已停止使用，请切换新智能助手进行使用。' : key
  })
}))

import LegacyAssistantInputbar from '../LegacyAssistantInputbar'

describe('deprecated assistant composer', () => {
  it('shows the exact notice and a grey non-interactive send action', () => {
    const submit = vi.fn()
    render(
      <div onClick={submit}>
        <LegacyAssistantInputbar />
      </div>
    )
    const input = screen.getByPlaceholderText('旧助手已停止使用，请切换新智能助手进行使用。')
    expect(input).toBeDisabled()
    expect(input).toHaveValue('')
    const send = screen.getByRole('button', { name: 'chat.input.send' })
    expect(send).toHaveAttribute('aria-disabled', 'true')
    expect(send).toHaveAttribute('tabindex', '-1')
    expect(send).toHaveStyle({ color: 'var(--color-text-3)', cursor: 'not-allowed' })
    fireEvent.keyDown(send, { key: 'Enter' })
    fireEvent.keyDown(send, { key: ' ' })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(submit).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /upload|attachment/i })).not.toBeInTheDocument()
  })
})
