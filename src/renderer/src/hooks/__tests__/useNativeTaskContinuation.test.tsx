import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {} as any,
  dispatch: vi.fn(),
  getSession: vi.fn(),
  send: vi.fn(),
  toast: vi.fn(),
  allowed: true
}))
vi.mock('@renderer/store', () => ({
  default: { getState: () => mocks.state },
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: (select: any) => select(mocks.state)
}))
vi.mock('@renderer/store/newMessage', () => ({ selectMessagesForTopic: () => mocks.state.turns }))
vi.mock('@renderer/store/thunk/messageThunk', () => ({ sendMessage: mocks.send }))
vi.mock('@renderer/hooks/agents/useAgentClient', () => ({ useAgentClient: () => ({ getSession: mocks.getSession }) }))
vi.mock('@renderer/config/agentModelPolicy', () => ({ isAssistantModelAllowed: () => mocks.allowed }))
vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { SEND_MESSAGE: 'send' },
  EventEmitter: { emit: vi.fn() }
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import type { Message } from '@renderer/types/newMessage'

import { useNativeTaskContinuation } from '../useNativeTaskContinuation'

const message = {
  id: 'reply',
  role: 'assistant',
  assistantId: DEFAULT_OPENCODE_AGENT_ID,
  topicId: 'agent-session:zen-session',
  status: 'paused',
  blocks: ['existing-file-result'],
  agentSessionId: 'native-session',
  model: { id: 'old-model' }
} as Message
const session = { model: 'provider:current-model', name: 'assistant', instructions: 'instructions', configuration: {} }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.allowed = true
  mocks.state = {
    turns: [structuredClone(message)],
    messages: { loadingByTopic: {} },
    settings: { enableDeveloperMode: false },
    llm: { providers: [{ id: 'provider', enabled: true, models: [{ id: 'current-model', provider: 'provider' }] }] }
  }
  mocks.getSession.mockResolvedValue(session)
  mocks.send.mockReturnValue({ type: 'normal-send' })
  mocks.dispatch.mockResolvedValue(undefined)
  window.toast = { warning: mocks.toast, error: mocks.toast } as any
})
describe('native task continuation', () => {
  it('appends one normal turn in the same session using its current model, without rewinding old history', async () => {
    const original = structuredClone(mocks.state.turns)
    const { result } = renderHook(() => useNativeTaskContinuation(message))
    await act(async () => result.current.continueTask())
    expect(mocks.getSession).toHaveBeenCalledWith(DEFAULT_OPENCODE_AGENT_ID, 'zen-session', { timeout: 5000 })
    expect(mocks.send).toHaveBeenCalledOnce()
    const [user, blocks, assistant, topic, context] = mocks.send.mock.calls[0]
    expect(user.id).not.toBe(message.id)
    expect(user).toMatchObject({ role: 'user', topicId: message.topicId, model: { id: 'current-model' } })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ content: 'assistantTaskContinuation.prompt' })
    expect(assistant.model.id).toBe('current-model')
    expect(topic).toBe(message.topicId)
    expect(context).toMatchObject({ sessionId: 'zen-session', agentId: DEFAULT_OPENCODE_AGENT_ID })
    expect(mocks.state.turns).toEqual(original)
  })
  it('locks duplicate clicks across controls while resolving the session', async () => {
    let resolve!: (value: any) => void
    mocks.getSession.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    const first = renderHook(() => useNativeTaskContinuation(message))
    const second = renderHook(() => useNativeTaskContinuation(message))
    let pending!: Promise<void>
    act(() => {
      pending = first.result.current.continueTask()
    })
    await act(async () => {
      await second.result.current.continueTask()
      resolve(session)
      await pending
    })
    expect(mocks.getSession).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledOnce()
  })
  it('does not continue an older answer, a running conversation or the retired assistant', async () => {
    for (const turns of [[message, { ...message, id: 'newer' }], [{ ...message, status: 'processing' }]]) {
      mocks.state.turns = turns
      const hook = renderHook(() => useNativeTaskContinuation(message))
      await act(async () => hook.result.current.continueTask())
      hook.unmount()
    }
    mocks.state.turns = [message]
    const hook = renderHook(() => useNativeTaskContinuation({ ...message, assistantId: 'legacy' }))
    await act(async () => hook.result.current.continueTask())
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.getSession).not.toHaveBeenCalled()
  })
  it('rechecks busy state and model policy after asynchronous lookup', async () => {
    mocks.getSession.mockImplementationOnce(async () => {
      mocks.state.messages.loadingByTopic[message.topicId] = true
      return session
    })
    const hook = renderHook(() => useNativeTaskContinuation(message))
    await act(async () => hook.result.current.continueTask())
    expect(mocks.send).not.toHaveBeenCalled()
    mocks.state.messages.loadingByTopic = {}
    mocks.allowed = false
    const second = renderHook(() => useNativeTaskContinuation(message))
    await act(async () => second.result.current.continueTask())
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith('agent.modelPolicy.noFallback')
  })
  it('unlocks after lookup failure and never submits with a removed model', async () => {
    mocks.getSession.mockRejectedValueOnce(new Error('local service unavailable'))
    const { result } = renderHook(() => useNativeTaskContinuation(message))
    await act(async () => result.current.continueTask())
    expect(result.current.submitting).toBe(false)
    mocks.state.llm.providers = []
    await act(async () => result.current.continueTask())
    expect(mocks.getSession).toHaveBeenCalledTimes(2)
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
