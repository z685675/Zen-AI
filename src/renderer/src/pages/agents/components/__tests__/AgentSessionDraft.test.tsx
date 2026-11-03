import { CacheService } from '@renderer/services/CacheService'
import { getAgentSessionDraft } from '@renderer/utils/agentSessionDraft'
import { shouldDiscardEmptyConversation } from '@renderer/utils/conversationDraft'
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  files: [],
  messages: [],
  dispatch: vi.fn(),
  sendMessage: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue({ type: 'send' }),
  resize: vi.fn(),
  focus: vi.fn(),
  setExpanded: vi.fn(),
  setFiles: vi.fn(),
  setCouldAddImageFile: vi.fn(),
  updateSession: vi.fn(),
  loading: false,
  addInput: vi.fn(),
  pauseQueue: vi.fn(),
  inboxEntries: [] as any[],
  state: {
    llm: {
      providers: [{ id: 'local', enabled: true, models: [{ id: 'test', name: 'Test', provider: 'local' }] }],
      modelPolicy: undefined
    },
    settings: { enableDeveloperMode: false }
  }
}))
vi.mock('@renderer/hooks/agents/useSession', () => ({
  useSession: (_agentId: string, id: string) => ({
    session: { id, name: 'Unnamed', model: 'local:test' },
    updateSession: mocks.updateSession
  })
}))
vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ apiServer: { enabled: true }, sendMessageShortcut: 'Enter' })
}))
vi.mock('@renderer/hooks/useTextareaResize', () => ({
  useTextareaResize: () => ({
    textareaRef: { current: null },
    resize: mocks.resize,
    focus: mocks.focus,
    setExpanded: mocks.setExpanded,
    setCustomHeight: mocks.resize
  })
}))
vi.mock('@renderer/hooks/useMessageOperations', () => ({ selectNewTopicLoading: () => mocks.loading }))
vi.mock('@renderer/services/AgentSessionInboxService', () => ({
  getAgentSessionInbox: () => ({
    subscribe: () => () => {},
    snapshot: () => mocks.inboxEntries,
    add: mocks.addInput,
    pause: mocks.pauseQueue,
    isPaused: () => false
  })
}))
vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: (selector: any) => selector(mocks.state)
}))
vi.mock('@renderer/store/newMessage', () => ({ selectMessagesForTopic: () => mocks.messages, newMessagesActions: {} }))
vi.mock('@renderer/store/thunk/messageThunk', () => ({
  sendMessage: (...args: unknown[]) => mocks.sendMessage(...args)
}))
vi.mock('@renderer/config/agentModelPolicy', () => ({ isAssistantModelAllowed: () => true }))
vi.mock('@renderer/config/models', () => ({ isVisionModel: () => false, isGenerateImageModel: () => false }))
vi.mock('@renderer/aiCore/utils/reasoning', () => ({ getAnthropicReasoningParams: () => ({}) }))
vi.mock('@renderer/services/FileManager', () => ({ default: {} }))
vi.mock('@renderer/services/SpanManagerService', () => ({ pauseTrace: vi.fn() }))
vi.mock('@renderer/services/TokenService', () => ({
  estimateUserPromptUsage: vi.fn().mockResolvedValue({ prompt_tokens: 1 })
}))
vi.mock('@renderer/pages/home/Inputbar/context/InputbarToolsProvider', () => ({
  InputbarToolsProvider: ({ children }: any) => <>{children}</>,
  useInputbarToolsState: () => ({ files: mocks.files }),
  useInputbarToolsDispatch: () => ({ setIsExpanded: mocks.setExpanded, setFiles: mocks.setFiles }),
  useInputbarToolsInternalDispatch: () => ({ setCouldAddImageFile: mocks.setCouldAddImageFile })
}))
vi.mock('@renderer/pages/home/Inputbar/registry', () => ({ getInputbarConfig: () => ({ showTools: false }) }))
vi.mock('@renderer/pages/home/Inputbar/InputbarTools', () => ({ default: () => null }))
vi.mock('@renderer/pages/home/Inputbar/components/ScrollToBottomButton', () => ({ default: () => null }))
vi.mock('../LegacyAssistantInputbar', () => ({ default: () => null }))
vi.mock('@renderer/pages/home/Inputbar/components/InputbarCore', () => ({
  InputbarCore: ({ text, onTextChange, handleSendMessage, rightToolbar, onPause }: any) => (
    <>
      <textarea aria-label="Draft" value={text} onChange={(event) => onTextChange(event.target.value)} />
      <button type="button" onClick={handleSendMessage}>
        Send
      </button>
      {rightToolbar}
      <button onClick={onPause}>Stop</button>
    </>
  )
}))

import AgentSessionInputbar from '../AgentSessionInputbar'

const agentId = 'zen-opencode-default'
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.dispatch.mockReset()
  CacheService.clear()
  localStorage.clear()
  window.toast = { info: vi.fn(), error: vi.fn() } as any
  mocks.loading = false
  mocks.inboxEntries = []
})
afterEach(() => vi.useRealTimers())

describe('assistant draft composer', () => {
  it('keeps a typed new conversation when switching sessions and leaving the page', () => {
    const view = render(<AgentSessionInputbar agentId={agentId} sessionId="one" variant="hero" />)
    fireEvent.change(view.getByLabelText('Draft'), { target: { value: '第一份未发送的草稿' } })
    expect(
      shouldDiscardEmptyConversation({ draft: getAgentSessionDraft(agentId, 'one'), messageCount: 0, isLoading: false })
    ).toBe(false)
    view.rerender(<AgentSessionInputbar agentId={agentId} sessionId="two" variant="hero" />)
    expect(view.getByLabelText('Draft')).toHaveValue('')
    fireEvent.change(view.getByLabelText('Draft'), { target: { value: '第二份草稿' } })
    view.rerender(<AgentSessionInputbar agentId={agentId} sessionId="one" variant="hero" />)
    expect(view.getByLabelText('Draft')).toHaveValue('第一份未发送的草稿')
    view.unmount()
    CacheService.clear()
    const returned = render(<AgentSessionInputbar agentId={agentId} sessionId="two" variant="hero" />)
    expect(returned.getByLabelText('Draft')).toHaveValue('第二份草稿')
  })

  it('clears the sent draft while retaining input typed immediately afterwards', async () => {
    const view = render(<AgentSessionInputbar agentId={agentId} sessionId="one" />)
    fireEvent.change(view.getByLabelText('Draft'), { target: { value: '发送这条内容' } })
    await act(async () => fireEvent.click(view.getByText('Send')))
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(view.getByLabelText('Draft')).toHaveValue('')
    expect(getAgentSessionDraft(agentId, 'one')).toBe('')
    fireEvent.change(view.getByLabelText('Draft'), { target: { value: '紧接着输入的新草稿' } })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(view.getByLabelText('Draft')).toHaveValue('紧接着输入的新草稿')
    view.unmount()
    CacheService.clear()
    const returned = render(<AgentSessionInputbar agentId={agentId} sessionId="one" />)
    expect(returned.getByLabelText('Draft')).toHaveValue('紧接着输入的新草稿')
  })

  it('clears the remounted conversation composer after the first message is saved', async () => {
    let finishSaving!: () => void
    mocks.dispatch.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishSaving = resolve
      })
    )
    const welcome = render(<AgentSessionInputbar agentId={agentId} sessionId="first-send" variant="hero" />)
    fireEvent.change(welcome.getByLabelText('Draft'), { target: { value: '欢迎页发送的首条消息' } })
    await act(async () => fireEvent.click(welcome.getByText('Send')))
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    // Saving the first message replaces the welcome layout before dispatch resolves.
    welcome.unmount()
    const conversation = render(<AgentSessionInputbar agentId={agentId} sessionId="first-send" />)
    await act(async () => finishSaving())
    expect(conversation.getByLabelText('Draft')).toHaveValue('')
    expect(getAgentSessionDraft(agentId, 'first-send')).toBe('')
  })

  it('keeps a new draft entered after navigating back while the previous send is saving', async () => {
    let finishSaving!: () => void
    mocks.dispatch.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishSaving = resolve
      })
    )
    const original = render(<AgentSessionInputbar agentId={agentId} sessionId="returning" />)
    fireEvent.change(original.getByLabelText('Draft'), { target: { value: '正在发送的消息' } })
    await act(async () => fireEvent.click(original.getByText('Send')))
    original.unmount()
    const returned = render(<AgentSessionInputbar agentId={agentId} sessionId="returning" />)
    fireEvent.change(returned.getByLabelText('Draft'), { target: { value: '返回后输入的新草稿' } })
    await act(async () => finishSaving())
    expect(returned.getByLabelText('Draft')).toHaveValue('返回后输入的新草稿')
    expect(getAgentSessionDraft(agentId, 'returning')).toBe('返回后输入的新草稿')
    returned.unmount()
    const reopened = render(<AgentSessionInputbar agentId={agentId} sessionId="returning" />)
    expect(reopened.getByLabelText('Draft')).toHaveValue('返回后输入的新草稿')
  })

  it('always queues during a run without asking the user to choose a sending mode first', async () => {
    mocks.loading = true
    const view = render(<AgentSessionInputbar agentId={agentId} sessionId="running" />)
    expect(view.queryByRole('button', { name: 'agent.inbox.queue' })).not.toBeInTheDocument()
    expect(view.queryByRole('button', { name: 'agent.inbox.steer' })).not.toBeInTheDocument()
    fireEvent.change(view.getByLabelText('Draft'), { target: { value: '完成后再整理为表格' } })
    await act(async () => fireEvent.click(view.getByText('Send')))
    expect(mocks.addInput).toHaveBeenLastCalledWith(expect.objectContaining({ text: '完成后再整理为表格' }), 'queue')
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(view.getByLabelText('Draft')).toHaveValue('')
    fireEvent.change(view.getByLabelText('Draft'), { target: { value: '先查最近三年的文献' } })
    await act(async () => fireEvent.click(view.getByText('Send')))
    expect(mocks.addInput).toHaveBeenLastCalledWith(expect.objectContaining({ text: '先查最近三年的文献' }), 'queue')
    fireEvent.click(view.getByText('Stop'))
    expect(mocks.pauseQueue).toHaveBeenCalledWith('running')
  })

  it('retains the draft if saving a queued message fails', async () => {
    mocks.loading = true
    mocks.addInput.mockImplementationOnce(() => {
      throw new Error('storage full')
    })
    const view = render(<AgentSessionInputbar agentId={agentId} sessionId="storage-error" />)
    fireEvent.change(view.getByLabelText('Draft'), { target: { value: '请保留这条补充' } })
    await act(async () => fireEvent.click(view.getByText('Send')))
    expect(view.getByLabelText('Draft')).toHaveValue('请保留这条补充')
    expect(getAgentSessionDraft(agentId, 'storage-error')).toBe('请保留这条补充')
  })

  it('uses normal sending again once the current task has finished', async () => {
    mocks.loading = true
    const view = render(<AgentSessionInputbar agentId={agentId} sessionId="finished" />)
    mocks.loading = false
    view.rerender(<AgentSessionInputbar agentId={agentId} sessionId="finished" />)
    expect(view.queryByRole('button', { name: 'agent.inbox.queue' })).not.toBeInTheDocument()
    expect(view.queryByRole('button', { name: 'agent.inbox.steer' })).not.toBeInTheDocument()
    fireEvent.change(view.getByLabelText('Draft'), { target: { value: '直接发起下一条消息' } })
    await act(async () => fireEvent.click(view.getByText('Send')))
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.addInput).not.toHaveBeenCalled()
  })

  it('queues behind an admission in progress before the loading indicator appears', async () => {
    mocks.inboxEntries = [{ sessionId: 'admitting', delivery: 'queue', state: 'sending' }]
    const view = render(<AgentSessionInputbar agentId={agentId} sessionId="admitting" />)
    fireEvent.change(view.getByLabelText('Draft'), { target: { value: '下一步要求' } })
    await act(async () => fireEvent.click(view.getByText('Send')))
    expect(mocks.addInput).toHaveBeenCalledWith(expect.objectContaining({ text: '下一步要求' }), 'queue')
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })
})
