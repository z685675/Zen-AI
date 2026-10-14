import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), deleteMessage: vi.fn(), modal: vi.fn(), info: vi.fn() }))
vi.mock('react-redux', () => ({
  useDispatch: () => mocks.dispatch,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({ runtime: { chat: { isMultiSelectMode: true, selectedMessageIds: ['message'] } } }),
  useStore: () => ({ getState: () => ({}) })
}))
vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useMessageOperations: () => ({ deleteMessage: mocks.deleteMessage })
}))
vi.mock('@renderer/store/messageBlock', () => ({ messageBlocksSelectors: { selectEntities: () => ({}) } }))
vi.mock('@renderer/store/newMessage', () => ({ selectMessagesForTopic: () => [] }))
vi.mock('@renderer/store/runtime', () => ({
  setActiveTopic: vi.fn(),
  setSelectedMessageIds: vi.fn(),
  toggleMultiSelectMode: vi.fn()
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import type { Topic } from '@renderer/types'

import { useChatContext } from '../useChatContext'

beforeEach(() => {
  vi.clearAllMocks()
  window.modal = { confirm: mocks.modal } as any
  window.toast = { info: mocks.info, warning: vi.fn() } as any
})
describe('native history batch operations', () => {
  it('does not display a misleading successful deletion for native messages', async () => {
    const { result } = renderHook(() =>
      useChatContext({ id: 'agent-session:new', assistantId: 'zen-opencode-default' } as Topic)
    )
    await result.current.handleMultiSelectAction('delete', ['message'])
    expect(mocks.info).toHaveBeenCalledWith('new_assistant.memory_notice')
    expect(mocks.modal).not.toHaveBeenCalled()
    expect(mocks.deleteMessage).not.toHaveBeenCalled()
  })
  it('preserves the old assistant delete confirmation', async () => {
    const { result } = renderHook(() => useChatContext({ id: 'agent-session:old', assistantId: 'legacy' } as Topic))
    await result.current.handleMultiSelectAction('delete', ['message'])
    expect(mocks.modal).toHaveBeenCalledOnce()
    expect(mocks.info).not.toHaveBeenCalled()
  })
})
