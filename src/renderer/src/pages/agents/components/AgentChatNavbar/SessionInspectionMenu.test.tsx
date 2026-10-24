import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  export: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
  messages: [] as any[],
  blocks: {}
}))
vi.mock('@renderer/hooks/agents/useAgentClient', () => ({
  useAgentClient: () => ({ inspectSessionSkills: mocks.inspect })
}))
vi.mock('@renderer/hooks/useMessageOperations', () => ({ useTopicMessages: () => mocks.messages }))
vi.mock('@renderer/store', () => ({ useAppSelector: (fn: any) => fn({ messageBlocks: { entities: mocks.blocks } }) }))
vi.mock('@renderer/services/ErrorDiagnosticPackageService', () => ({
  exportErrorDiagnosticPackage: mocks.export,
  getDiagnosticAppInfo: async () => ({ version: 'test' })
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('antd', () => ({
  Checkbox: ({ children }: any) => <span>{children}</span>,
  Button: ({ children, onClick, ...props }: any) => (
    <button type="button" onClick={onClick} aria-label={props['aria-label']}>
      {children}
    </button>
  ),
  Dropdown: ({ menu }: any) => (
    <div>
      {menu.items.map((item: any) => (
        <button type="button" key={item.key} disabled={item.disabled} onClick={() => menu.onClick({ key: item.key })}>
          {item.label}
        </button>
      ))}
    </div>
  ),
  Modal: ({ open, children, onCancel }: any) =>
    open ? (
      <div>
        <button type="button" onClick={onCancel}>
          close
        </button>
        {children}
      </div>
    ) : null,
  Alert: ({ message }: any) => <div>{message}</div>,
  Spin: () => <div>busy</div>,
  Table: ({ dataSource }: any) => (
    <div>
      {dataSource.map((item: any) => (
        <div key={item.path}>{item.name}</div>
      ))}
    </div>
  ),
  Tag: ({ children }: any) => <span>{children}</span>
}))

import SessionInspectionMenu from './SessionInspectionMenu'

const session = {
  id: 's',
  agent_id: 'zen-opencode-default',
  model: 'provider:model',
  accessible_paths: ['/workspace']
} as any
beforeEach(() => {
  vi.clearAllMocks()
  mocks.messages = [
    { id: 'user', role: 'user', blocks: [] },
    { id: 'reply', role: 'assistant', askId: 'user', blocks: [], status: 'processing' }
  ]
  mocks.inspect.mockResolvedValue({
    nativeStatus: 'not-running',
    refreshRequired: false,
    skills: [{ name: 'xlsx', path: '/skill/xlsx' }]
  })
  mocks.export.mockResolvedValue('/saved.zip')
  window.modal = { confirm: mocks.confirm } as any
  window.toast = { success: mocks.toast, error: mocks.toast } as any
})
describe('current-session inspection menu', () => {
  it('loads only on click, never initializes a runtime, and shows unconfirmed discovery honestly', async () => {
    render(<SessionInspectionMenu session={session} />)
    expect(mocks.inspect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('assistantPeripheral.skillsTitle'))
    await screen.findByText('xlsx')
    expect(mocks.inspect).toHaveBeenCalledWith('zen-opencode-default', 's')
    expect(screen.getByText('assistantPeripheral.native_not-running')).toBeTruthy()
    expect(screen.getByText('assistantPeripheral.noCallEvidence')).toBeTruthy()
  })
  it('discards an old-session response after switching and allows a fresh inspection', async () => {
    let resolve: (value: any) => void = () => undefined
    mocks.inspect.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const view = render(<SessionInspectionMenu session={session} />)
    fireEvent.click(screen.getByText('assistantPeripheral.skillsTitle'))
    view.rerender(<SessionInspectionMenu session={{ ...session, id: 'new' }} />)
    await act(async () => resolve({ nativeStatus: 'observed', skills: [{ name: 'OLD_PRIVATE_SKILL', path: '/old' }] }))
    expect(screen.queryByText('OLD_PRIVATE_SKILL')).toBeNull()
    fireEvent.click(screen.getByText('assistantPeripheral.skillsTitle'))
    await screen.findByText('xlsx')
    expect(mocks.inspect).toHaveBeenLastCalledWith('zen-opencode-default', 'new')
  })
  it('confirms privacy first, snapshots only the selected turn, and never fabricates failure', async () => {
    render(<SessionInspectionMenu session={session} />)
    fireEvent.click(screen.getByText('turnDiagnostics.export'))
    fireEvent.click(screen.getByText('turnDiagnostics.export'))
    expect(mocks.confirm).toHaveBeenCalledOnce()
    expect(mocks.export).not.toHaveBeenCalled()
    expect(mocks.confirm.mock.calls[0][0].title).toBe('turnDiagnostics.export')
    await act(async () => mocks.confirm.mock.calls[0][0].onOk())
    expect(mocks.export).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent', message: mocks.messages[1], relatedUserMessage: mocks.messages[0] })
    )
    expect(mocks.export.mock.calls[0][0].diagnosis).toBeUndefined()
    expect(mocks.export.mock.calls[0][0].includeContent).toBe(false)
    expect(mocks.inspect).not.toHaveBeenCalled()
  })
  it('does not export on cancel and permits a later request', async () => {
    render(<SessionInspectionMenu session={session} />)
    fireEvent.click(screen.getByText('turnDiagnostics.export'))
    mocks.confirm.mock.calls[0][0].onCancel()
    expect(mocks.export).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('turnDiagnostics.export'))
    expect(mocks.confirm).toHaveBeenCalledTimes(2)
  })
  it('can export an empty conversation without inventing a recorded turn', async () => {
    mocks.messages = []
    render(<SessionInspectionMenu session={session} />)
    fireEvent.click(screen.getByText('turnDiagnostics.export'))
    await act(async () => mocks.confirm.mock.calls[0][0].onOk())
    await waitFor(() => expect(mocks.export).toHaveBeenCalledOnce())
    expect(mocks.export.mock.calls[0][0].sessionContext.hasRecordedTurn).toBe(false)
  })
  it('does not export an old answer as the current task when a new user turn has no assistant record yet', async () => {
    mocks.messages.push({ id: 'new-user', role: 'user', blocks: [] })
    render(<SessionInspectionMenu session={session} />)
    fireEvent.click(screen.getByText('turnDiagnostics.export'))
    await act(async () => mocks.confirm.mock.calls[0][0].onOk())
    expect(mocks.export.mock.calls[0][0].snapshotHasMessage).toBe(false)
    expect(mocks.export.mock.calls[0][0].relatedUserMessage.id).toBe('new-user')
    expect(mocks.export.mock.calls[0][0].message.id).not.toBe('reply')
  })
})
