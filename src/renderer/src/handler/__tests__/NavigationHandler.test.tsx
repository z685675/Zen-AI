import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { IpcChannel } from '@shared/IpcChannel'
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  dispatch: vi.fn(),
  confirm: vi.fn(),
  getSession: vi.fn(),
  listeners: new Map<string, (...args: any[]) => void>(),
  removers: [] as Array<ReturnType<typeof vi.fn>>
}))
vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: () => true,
  default: { getState: () => ({ settings: { notification: { assistant: false } } }) }
}))
vi.mock('@renderer/hooks/agents/useAgentClient', () => ({ useAgentClient: () => ({ getSession: mocks.getSession }) }))
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: '/new-assistant' })
}))
vi.mock('react-hotkeys-hook', () => ({ useHotkeys: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/i18n', () => ({ default: { t: (key: string) => key } }))

import NavigationHandler from '../NavigationHandler'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listeners.clear()
  mocks.removers.length = 0
  mocks.getSession.mockResolvedValue({ id: 'original-session' })
  window.modal = { confirm: mocks.confirm } as any
  window.electron = {
    ipcRenderer: {
      on: (channel: string, listener: (...args: any[]) => void) => {
        mocks.listeners.set(channel, listener)
        const remove = vi.fn(() => mocks.listeners.delete(channel))
        mocks.removers.push(remove)
        return remove
      }
    }
  } as any
})
describe('browser action-required continuation', () => {
  it.each([
    [DEFAULT_OPENCODE_AGENT_ID, '/new-assistant'],
    ['legacy-agent', '/agents']
  ])('returns %s to its own workspace', async (agentId, route) => {
    const view = render(<NavigationHandler />)
    mocks.listeners.get(IpcChannel.Agent_ActionRequired)!(
      {},
      { agentId, sessionId: 'original-session', message: 'Ready' }
    )
    expect(mocks.navigate).not.toHaveBeenCalled()
    await mocks.confirm.mock.calls[0][0].onOk()
    expect(mocks.dispatch.mock.calls.map(([action]) => action.payload)).toEqual([
      agentId,
      { agentId, sessionId: 'original-session' }
    ])
    expect(mocks.navigate).toHaveBeenCalledWith(route)
    view.unmount()
    expect(mocks.removers.every((remove) => remove.mock.calls.length === 1)).toBe(true)
  })
  it('does not navigate when the modal is dismissed or deferred', () => {
    const view = render(<NavigationHandler />)
    mocks.listeners.get(IpcChannel.Agent_ActionRequired)!(
      {},
      { agentId: DEFAULT_OPENCODE_AGENT_ID, sessionId: 'original', message: 'Ready' }
    )
    mocks.confirm.mock.calls[0][0].onCancel?.()
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    view.unmount()
  })
  it('opens native notifications in the new workspace after checking existence, without executing anything', async () => {
    const view = render(<NavigationHandler />)
    mocks.listeners.get('notification-click')!(
      {},
      { meta: { assistantTarget: { agentId: DEFAULT_OPENCODE_AGENT_ID, sessionId: 'original-session' } } }
    )
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/new-assistant'))
    expect(mocks.getSession).toHaveBeenCalledWith(DEFAULT_OPENCODE_AGENT_ID, 'original-session', { timeout: 3000 })
    expect(mocks.dispatch.mock.calls[1][0].payload).toEqual({
      agentId: DEFAULT_OPENCODE_AGENT_ID,
      sessionId: 'original-session'
    })
    view.unmount()
  })
  it('keeps selection unchanged for deleted sessions and ignores repeated handoff events', async () => {
    mocks.getSession.mockRejectedValue(new Error('deleted'))
    window.toast = { info: vi.fn() } as any
    const view = render(<NavigationHandler />)
    mocks.listeners.get('notification-click')!(
      {},
      { meta: { assistantTarget: { agentId: DEFAULT_OPENCODE_AGENT_ID, sessionId: 'deleted' } } }
    )
    await waitFor(() => expect(window.toast.info).toHaveBeenCalled())
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    const payload = {
      agentId: DEFAULT_OPENCODE_AGENT_ID,
      sessionId: 'same',
      requestId: 'handoff-1',
      reason: 'browser_handoff',
      message: 'Login'
    }
    mocks.listeners.get(IpcChannel.Agent_ActionRequired)!({}, payload)
    mocks.listeners.get(IpcChannel.Agent_ActionRequired)!({}, payload)
    expect(mocks.confirm).toHaveBeenCalledOnce()
    view.unmount()
  })
})
