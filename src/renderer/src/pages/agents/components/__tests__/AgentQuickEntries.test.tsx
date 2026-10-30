import '@ant-design/v5-patch-for-react-19'

import { AgentWorkspaceContext } from '@renderer/context/AgentWorkspaceProvider'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Modal } from 'antd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ api: vi.fn(), navigate: vi.fn(), dispatch: vi.fn() }))
const getComputedStyle = window.getComputedStyle.bind(window)
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/hooks/agents/useModels', () => ({ useApiModels: () => ({ models: [] }) }))
vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: (select: (state: unknown) => unknown) => select({ settings: { enableDeveloperMode: false }, llm: {} })
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }))
vi.mock('@renderer/pages/settings/SkillsSettings', () => ({ default: () => <div>Skills manager</div> }))

import AgentQuickEntries from '../AgentQuickEntries'

const overview = () => ({
  connection: { status: 'disconnected' },
  tasks: [],
  runs: [],
  sessions: [],
  deliveries: [],
  legacyTasks: []
})

const renderNewAssistant = () =>
  render(
    <AgentWorkspaceContext value="opencode">
      <AgentQuickEntries />
    </AgentWorkspaceContext>
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => getComputedStyle(element))
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  )
  window.api.assistantAutomation = mocks.api
  mocks.api.mockImplementation(async () => ({ ok: true, data: overview() }))
})

afterEach(() => {
  Modal.destroyAll()
  vi.restoreAllMocks()
})

describe('new assistant home quick entries', () => {
  it('keeps the retired assistant read-only without showing new automation controls', () => {
    render(<AgentQuickEntries />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(mocks.api).not.toHaveBeenCalled()
  })

  it('shows all three home entries and preserves the skills manager', async () => {
    renderNewAssistant()
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'automation.wechatagent.welcome.quick_entries.wechat_desc',
      'automation.scheduleagent.welcome.quick_entries.tasks_desc',
      'settings.skills.titleagent.welcome.quick_entries.skills_desc'
    ])
    expect(screen.getByRole('button', { name: /^automation.schedule/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^automation.wechat/ })).toBeInTheDocument()
    expect(mocks.api).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^settings.skills.title/ }))
    expect(await screen.findByText('Skills manager')).toBeInTheDocument()
    expect(mocks.api).not.toHaveBeenCalled()
  })

  it('opens the new scheduled-task manager directly and resets its tab on reopening', async () => {
    renderNewAssistant()
    fireEvent.click(screen.getByRole('button', { name: /^automation.schedule/ }))
    expect(await screen.findByRole('tab', { name: 'automation.schedule' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'automation.addTask' })).toBeInTheDocument()
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith({ action: 'status' }))
    expect(screen.queryByText('assistant_transition.legacy_automation_disabled')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'automation.wechat' }))
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^automation.schedule/ }))
    expect(await screen.findByRole('tab', { name: 'automation.schedule' })).toHaveAttribute('aria-selected', 'true')
    expect(mocks.api.mock.calls.every(([request]) => request.action === 'status')).toBe(true)
  })

  it('opens WeChat connection controls without logging in or enabling anything automatically', async () => {
    renderNewAssistant()
    fireEvent.click(screen.getByRole('button', { name: /^automation.wechat/ }))
    expect(await screen.findByRole('tab', { name: 'automation.wechat' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'automation.scan' })).toBeInTheDocument()
    expect(screen.getByText('automation.scope')).toBeInTheDocument()
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith({ action: 'status' }))
    expect(mocks.api.mock.calls.every(([request]) => request.action === 'status')).toBe(true)
  })

  it('closes the home modal when continuing a bound conversation in the new assistant', async () => {
    mocks.api.mockResolvedValue({
      ok: true,
      data: { ...overview(), connection: { status: 'connected', sessionId: 'wechat-session', enabled: true } }
    })
    renderNewAssistant()
    fireEvent.click(screen.getByRole('button', { name: /^automation.wechat/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'automation.openConversation' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'automation.openConversation' }))
    expect(mocks.navigate).toHaveBeenCalledWith('/new-assistant')
    expect(mocks.dispatch).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
