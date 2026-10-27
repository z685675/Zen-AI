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
vi.mock('@renderer/hooks/useMessageOperations', () => ({ selectNewTopicLoading: () => false }))
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
vi.mock('../AutomationSessionBanner', () => ({ default: () => null }))
vi.mock('../LegacyAssistantInputbar', () => ({ default: () => null }))
vi.mock('@renderer/pages/home/Inputbar/components/InputbarCore', () => ({
  InputbarCore: ({ text, onTextChange, handleSendMessage }: any) => (
    <>
      <textarea aria-label="Draft" value={text} onChange={(event) => onTextChange(event.target.value)} />
      <button type="button" onClick={handleSendMessage}>
        Send
      </button>
    </>
  )
}))

import AgentSessionInputbar from '../AgentSessionInputbar'

const agentId = 'zen-opencode-default'
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  CacheService.clear()
  localStorage.clear()
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
})
