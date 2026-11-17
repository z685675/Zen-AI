import zh from '@renderer/i18n/locales/zh-cn.json'
import { ERROR_I18N_KEY_STREAM_PAUSED } from '@renderer/types/error'
import type { ErrorMessageBlock, Message } from '@renderer/types/newMessage'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18next from 'i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {} as any,
  dispatch: vi.fn(),
  detail: vi.fn(),
  exportPackage: vi.fn(),
  continueTask: vi.fn(),
  toast: vi.fn()
}))

vi.mock('@renderer/components/ErrorDetailModal', () => ({ showErrorDetailPopup: mocks.detail }))
vi.mock('@renderer/hooks/useTimer', () => ({ useTimer: () => ({ setTimeoutTimer: vi.fn() }) }))
vi.mock('@renderer/hooks/agents/useAgentClient', () => ({
  useAgentClient: () => ({ getSession: async () => ({ id: 'session' }) })
}))
vi.mock('@renderer/hooks/useNativeTaskContinuation', () => ({
  useNativeTaskContinuation: () => ({ canContinue: true, submitting: false, continueTask: mocks.continueTask })
}))
vi.mock('@renderer/services/ErrorDiagnosticPackageService', () => ({
  getDiagnosticAppInfo: async () => ({ version: 'test' }),
  exportErrorDiagnosticPackage: mocks.exportPackage
}))
vi.mock('@renderer/store', () => ({
  default: { getState: () => mocks.state },
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: (select: any) => select(mocks.state)
}))
vi.mock('@renderer/store/thunk/messageThunk', () => ({ removeBlocksThunk: vi.fn(), resendMessageThunk: vi.fn() }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: i18next.t.bind(i18next) }) }))

import ErrorBlock from '../ErrorBlock'

beforeAll(async () => {
  await i18next.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zh } } })
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state = {
    messages: { entities: { question: { id: 'question', role: 'user' } }, loadingByTopic: {} },
    messageBlocks: { entities: {} }
  }
  mocks.exportPackage.mockResolvedValue('diagnostics.zip')
  window.toast = { success: mocks.toast, error: mocks.toast } as any
})

function example(agent: boolean, error: Record<string, unknown>) {
  return {
    message: {
      id: 'reply',
      role: 'assistant',
      askId: 'question',
      assistantId: agent ? DEFAULT_OPENCODE_AGENT_ID : 'assistant',
      topicId: agent ? 'agent-session:session' : 'topic',
      blocks: ['error'],
      model: { id: 'model', provider: 'provider', name: 'Model' }
    } as Message,
    block: {
      id: 'error',
      type: 'error',
      messageId: 'reply',
      error: { name: 'Error', message: 'failure', stack: null, ...error }
    } as ErrorMessageBlock
  }
}

describe.each([false, true])('outer failure card (agent=%s)', (agent) => {
  it.each([
    { statusCode: 403, message: 'No permission to access group gemini-poe' },
    { statusCode: 429, message: 'insufficient_quota' },
    { statusCode: 500, message: 'server unavailable' },
    { message: 'context_length_exceeded' },
    { message: 'Failed to fetch' },
    { name: 'TimeoutError', message: 'response timeout' },
    { zenFailureStage: 'runtime-startup', message: 'OpenCode process exited during startup' }
  ])('shows recovery instructions without opening details for $message', (error) => {
    const { container } = render(<ErrorBlock {...example(agent, error)} />)
    expect(screen.getByText(agent ? zh.error.fallback.task_title : zh.error.fallback.reply_title)).toBeVisible()
    expect(screen.getByText(zh.error.fallback.description)).toBeVisible()
    expect(screen.getByRole('button', { name: zh.agent.errorFallback.export_package })).toBeEnabled()
    expect(container.textContent).not.toContain('账号权限异常')
    expect(container.textContent).not.toContain(error.message)
    expect(container.querySelector('[class*="line-clamp"]')).toBeNull()
    expect(mocks.detail).not.toHaveBeenCalled()
    expect(mocks.continueTask).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    if (agent) expect(screen.getByText(zh.error.fallback.check_results)).toBeVisible()
  })

  it('exports the original error and diagnosis from the visible button without opening details', async () => {
    const props = example(agent, { statusCode: 403, message: 'No permission to access group gemini-poe' })
    render(<ErrorBlock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.agent.errorFallback.export_package }))
    await waitFor(() => expect(mocks.exportPackage).toHaveBeenCalledOnce())
    expect(mocks.exportPackage.mock.calls[0][0]).toMatchObject({
      error: props.block.error,
      diagnosis: { category: 'account', httpStatus: '403', title: '生成失败：账号权限异常' }
    })
    expect(mocks.detail).not.toHaveBeenCalled()
  })

  it('keeps explicit user stops distinct from failures', () => {
    render(<ErrorBlock {...example(agent, { i18nKey: ERROR_I18N_KEY_STREAM_PAUSED })} />)
    expect(screen.getByText('已停止')).toBeVisible()
    expect(screen.queryByText(zh.error.fallback.description)).toBeNull()
  })
})

it('keeps task-capacity guidance outside the generic failure card', () => {
  render(<ErrorBlock {...example(true, { code: 'agent_task_limit', zenTaskLimit: { limit: 1, activeTasks: 1 } })} />)
  expect(screen.getByRole('status')).toHaveTextContent('任务名额已满')
  expect(screen.queryByText(zh.error.fallback.description)).toBeNull()
})

it.each([
  ['agent_execution_timeout', zh.assistantTaskDeadline.titleExecution],
  ['agent_inactivity_timeout', zh.assistantTaskDeadline.titleInactivity],
  ['agent_human_wait_timeout', zh.assistantTaskDeadline.titleHumanWait]
])('preserves the paused-state explanation for %s', (code, title) => {
  render(<ErrorBlock {...example(true, { code })} />)
  expect(screen.getByText(title)).toBeVisible()
  expect(screen.queryByText(zh.error.fallback.description)).toBeNull()
})
