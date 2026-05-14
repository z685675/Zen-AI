import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PanelConfig } from '../components/KnowledgeSettings/KnowledgeBaseFormModal'
import KnowledgeBaseFormModal from '../components/KnowledgeSettings/KnowledgeBaseFormModal'

const mocks = vi.hoisted(() => ({
  onCancel: vi.fn(),
  onOk: vi.fn(),
  onMoreSettings: vi.fn(),
  t: (key: string) => key
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))

vi.mock('lucide-react', () => ({
  ChevronDown: () => <span data-testid="chevron-down">v</span>,
  ChevronUp: () => <span data-testid="chevron-up">^</span>
}))

vi.mock('antd', () => ({
  Modal: ({ children, open, footer, ...props }: any) =>
    open ? (
      <div data-testid="modal" {...props}>
        <div data-testid="modal-body">{children}</div>
        {footer && <div data-testid="modal-footer">{footer}</div>}
      </div>
    ) : null,
  Button: ({ children, onClick, icon, type, ...props }: any) => (
    <button type="button" data-testid="button" data-type={type} onClick={onClick} {...props}>
      {icon}
      {children}
    </button>
  )
}))

const createPanelConfigs = (): PanelConfig[] => [
  {
    key: 'general',
    label: 'General Settings',
    panel: <div data-testid="general-panel">General Settings Content</div>
  },
  {
    key: 'advanced',
    label: 'Advanced Settings',
    panel: <div data-testid="advanced-panel">Advanced Settings Content</div>
  }
]

describe('KnowledgeBaseFormModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('matches snapshot', () => {
    const { container } = render(
      <KnowledgeBaseFormModal panels={createPanelConfigs()} open={true} onOk={mocks.onOk} onCancel={mocks.onCancel} />
    )

    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders modal and general panel by default', () => {
    render(
      <KnowledgeBaseFormModal panels={createPanelConfigs()} open={true} onOk={mocks.onOk} onCancel={mocks.onCancel} />
    )

    expect(screen.getByTestId('modal')).toBeInTheDocument()
    expect(screen.getByTestId('general-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('advanced-panel')).not.toBeInTheDocument()
  })

  it('shows advanced panel when toggled', () => {
    render(
      <KnowledgeBaseFormModal panels={createPanelConfigs()} open={true} onOk={mocks.onOk} onCancel={mocks.onCancel} />
    )

    fireEvent.click(screen.getAllByTestId('button')[0])
    expect(screen.getByTestId('advanced-panel')).toBeInTheDocument()
  })

  it('renders more settings button when handler is provided', () => {
    render(
      <KnowledgeBaseFormModal
        panels={createPanelConfigs()}
        open={true}
        onOk={mocks.onOk}
        onCancel={mocks.onCancel}
        onMoreSettings={mocks.onMoreSettings}
      />
    )

    expect(screen.getAllByTestId('button').length).toBeGreaterThan(2)
  })
})
