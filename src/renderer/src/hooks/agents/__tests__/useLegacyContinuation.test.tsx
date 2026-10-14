import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  continue: vi.fn(),
  dispatch: vi.fn(),
  confirm: vi.fn(),
  navigate: vi.fn(),
  success: vi.fn(),
  error: vi.fn()
}))
vi.mock('@renderer/hooks/agents/useAgentClient', () => ({
  useAgentClient: () => ({ continueInNewAssistant: mocks.continue })
}))
vi.mock('@renderer/store', () => ({ useAppDispatch: () => mocks.dispatch }))
vi.mock('@renderer/store/runtime', () => ({
  setActiveAgentId: (id: string) => ({ type: 'agent', id }),
  setActiveSessionIdAction: (payload: unknown) => ({ type: 'session', payload })
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

import { useLegacyContinuation } from '../useLegacyContinuation'

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, {
    modal: { confirm: mocks.confirm },
    navigate: mocks.navigate,
    toast: { success: mocks.success, error: mocks.error }
  })
})
describe('legacy continuation interaction', () => {
  it('asks before copying, blocks repeated confirmation and only navigates after success', async () => {
    mocks.continue.mockResolvedValue({ session: { id: 'copy' }, reused: false })
    const { result } = renderHook(() => useLegacyContinuation('legacy', 'old'))
    act(() => {
      result.current.continueInNew()
      result.current.continueInNew()
    })
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.continue).not.toHaveBeenCalled()
    await act(() => mocks.confirm.mock.calls[0][0].onOk())
    expect(mocks.continue).toHaveBeenCalledWith('legacy', 'old')
    expect(mocks.dispatch.mock.calls).toEqual([
      [{ type: 'agent', id: 'zen-opencode-default' }],
      [{ type: 'session', payload: { agentId: 'zen-opencode-default', sessionId: 'copy' } }]
    ])
    expect(mocks.navigate).toHaveBeenCalledWith('/new-assistant')
    expect(result.current.busy).toBe(false)
  })
  it('keeps the old page if transfer fails and allows retry', async () => {
    mocks.continue.mockRejectedValue(new Error('connection lost'))
    const { result } = renderHook(() => useLegacyContinuation('legacy', 'old'))
    act(() => result.current.continueInNew())
    await act(() => mocks.confirm.mock.calls[0][0].onOk())
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith('assistant_transition.continuation_prepare_failed')
    act(() => result.current.continueInNew())
    expect(mocks.confirm).toHaveBeenCalledTimes(2)
  })
  it('cancel does not touch data or send requests', () => {
    const { result } = renderHook(() => useLegacyContinuation('legacy', 'old'))
    act(() => result.current.continueInNew())
    act(() => {
      mocks.confirm.mock.calls[0][0].onCancel()
    })
    expect(mocks.continue).not.toHaveBeenCalled()
    act(() => result.current.continueInNew())
    expect(mocks.confirm).toHaveBeenCalledTimes(2)
  })
})
