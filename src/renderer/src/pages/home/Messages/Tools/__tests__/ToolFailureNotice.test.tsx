import zhCN from '@renderer/i18n/locales/zh-cn.json'
import { createAssistantToolFailure } from '@shared/agents/toolFailure'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ToolFailureNotice } from '../MessageAgentTools/ToolFailureNotice'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.split('.').reduce((value: any, part) => value?.[part], zhCN) || key
  })
}))

describe('ToolFailureNotice', () => {
  it('renders clear guidance with collapsed redacted details and no automatic action button', () => {
    const failure = createAssistantToolFailure(
      'python_execute',
      "ModuleNotFoundError: No module named 'missing'; password=secret"
    )
    const { container } = render(<ToolFailureNotice response={JSON.stringify({ failure })} />)
    expect(screen.getByRole('status')).toHaveTextContent('缺少依赖')
    expect(screen.getByRole('status')).toHaveTextContent('征得你的同意')
    expect(container.querySelector('details')).not.toHaveAttribute('open')
    expect(container.textContent).not.toContain('password=secret')
    expect(screen.queryByRole('button')).toBeNull()
    fireEvent.click(screen.getByText('技术详情'))
    expect(container.querySelector('pre')).toHaveTextContent('ModuleNotFoundError')
  })

  it('does not treat ordinary tool output or unversioned errors as product failures', () => {
    const { container, rerender } = render(<ToolFailureNotice response="Error: unknown" />)
    expect(container).toBeEmptyDOMElement()
    rerender(<ToolFailureNotice response={{ message: 'The analysis found no errors' }} />)
    expect(container).toBeEmptyDOMElement()
  })
})
