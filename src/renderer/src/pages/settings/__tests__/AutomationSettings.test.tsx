import '@ant-design/v5-patch-for-react-19'

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

import AutomationSettings from '../AutomationSettings'

const overview = () => ({
  connection: { status: 'disconnected' },
  tasks: [],
  runs: [],
  sessions: [],
  deliveries: [],
  legacyTasks: []
})

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

describe('new assistant opt-in automation settings', () => {
  it('only reads status until the user explicitly confirms a login', async () => {
    render(<AutomationSettings />)
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith({ action: 'status' }))
    expect(mocks.api.mock.calls.every(([request]) => request.action === 'status')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'automation.scan' }))
    expect(await screen.findByText('automation.loginConsent')).toBeInTheDocument()
    expect(mocks.api).not.toHaveBeenCalledWith({ action: 'login' })
    fireEvent.click(screen.getByRole('button', { name: 'automation.confirm' }))
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith({ action: 'login' }))
  })
  it('opens the bound conversation in the new assistant, never the old assistant', async () => {
    mocks.api.mockResolvedValue({
      ok: true,
      data: { ...overview(), connection: { status: 'connected', sessionId: 'wechat-session', enabled: true } }
    })
    render(<AutomationSettings />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'automation.openConversation' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'automation.openConversation' }))
    expect(mocks.navigate).toHaveBeenCalledWith('/new-assistant')
    expect(mocks.dispatch).toHaveBeenCalledTimes(2)
  })
  it('shows a stale notification authorization and does not auto-run old tasks', async () => {
    mocks.api.mockResolvedValue({
      ok: true,
      data: {
        ...overview(),
        tasks: [{ id: 'task', name: 'brief', status: 'active', notificationNeedsConfirmation: true }],
        legacyTasks: [
          { id: 'old-task', name: 'old task', prompt: 'old prompt', scheduleType: 'interval', scheduleValue: '5' }
        ]
      }
    })
    render(<AutomationSettings />)
    fireEvent.click(screen.getByRole('tab', { name: 'automation.schedule' }))
    expect(await screen.findByText('automation.notificationNeedsConfirmation')).toBeInTheDocument()
    expect(mocks.api.mock.calls.every(([request]) => request.action === 'status')).toBe(true)
  })
})
