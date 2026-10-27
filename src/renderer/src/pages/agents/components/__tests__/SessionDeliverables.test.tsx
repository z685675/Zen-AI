import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  messages: [] as Message[],
  state: { messageBlocks: { entities: {} as Record<string, MessageBlock> } },
  check: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
  toast: vi.fn(),
  emit: vi.fn()
}))
vi.mock('@renderer/hooks/useMessageOperations', () => ({ useTopicMessages: () => mocks.messages }))
vi.mock('@renderer/store', () => ({ useAppSelector: (select: any) => select(mocks.state) }))
vi.mock('@renderer/services/EventService', () => ({
  EventEmitter: { emit: mocks.emit },
  EVENT_NAMES: { LOCATE_MESSAGE: 'LOCATE_MESSAGE' }
}))
vi.mock('react-i18next', async () => {
  const { default: locale } = await import('@renderer/i18n/locales/zh-cn.json')
  return {
    useTranslation: () => ({
      t: (key: string, values?: Record<string, unknown>) => {
        const template = key.split('.').reduce((object: any, field) => object?.[field], locale) ?? key
        return template.replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => String(values?.[name] ?? ''))
      }
    }),
    initReactI18next: { type: '3rdParty', init: vi.fn() }
  }
})
import SessionDeliverables from '../SessionDeliverables'

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }))
  })
  mocks.messages = [
    { id: 'user', role: 'user', blocks: [] },
    { id: 'reply', role: 'assistant', blocks: ['output'] }
  ] as Message[]
  mocks.state.messageBlocks.entities = {
    output: {
      id: 'output',
      messageId: 'reply',
      type: MessageBlockType.TOOL,
      status: MessageBlockStatus.SUCCESS,
      metadata: {
        rawMcpToolResponse: {
          status: 'done',
          tool: { id: 'mcp__assistant__present_files', name: 'mcp__assistant__present_files' },
          response: { files: [{ path: 'C:/output/report.xlsx' }, { path: 'C:/output/project', kind: 'directory' }] }
        }
      }
    } as MessageBlock
  }
  mocks.open.mockResolvedValue(undefined)
  mocks.reveal.mockResolvedValue(undefined)
  mocks.check
    .mockReset()
    .mockImplementation(async (paths: string[]) => paths.map((path) => ({ path, status: 'available' })))
  Object.assign(window, {
    api: { file: { openPath: mocks.open, showInFolder: mocks.reveal, checkPaths: mocks.check } },
    toast: { error: mocks.toast }
  })
})

describe('conversation output panel', () => {
  it('lists outputs outside tool folds and really opens, reveals and navigates to their origin', async () => {
    render(<SessionDeliverables topicId="agent-session:one" />)
    fireEvent.click(screen.getByRole('button', { name: '成果 · 2' }))
    expect(await screen.findByText('report.xlsx')).toBeVisible()
    expect(screen.getByText('project')).toBeVisible()
    await waitFor(() => expect(screen.getAllByRole('button', { name: /打\s*开/ })[1]).toBeEnabled())
    fireEvent.click(screen.getAllByRole('button', { name: /打\s*开/ })[1])
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith('C:/output/report.xlsx'))
    fireEvent.click(screen.getByRole('button', { name: '定位文件' }))
    await waitFor(() => expect(mocks.reveal).toHaveBeenCalledWith('C:/output/report.xlsx'))
    fireEvent.click(screen.getAllByRole('button', { name: '查看对应回答' })[1])
    expect(mocks.emit).toHaveBeenCalledWith('LOCATE_MESSAGE', { topicId: 'agent-session:one', messageId: 'reply' })
  })
  it('searches locally, reports missing files without removing saved entries, and reconstructs after remount', async () => {
    const { unmount } = render(<SessionDeliverables topicId="agent-session:one" />)
    fireEvent.click(screen.getByRole('button', { name: '成果 · 2' }))
    const search = await screen.findByRole('searchbox', { name: '搜索文件名称或路径' })
    fireEvent.change(search, { target: { value: 'report' } })
    expect(screen.queryByText('project')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /打\s*开/ })).toBeEnabled())
    mocks.open.mockRejectedValue(new Error('missing'))
    fireEvent.click(screen.getByRole('button', { name: /打\s*开/ }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    expect(screen.getByText('report.xlsx')).toBeVisible()
    unmount()
    render(<SessionDeliverables topicId="agent-session:one" />)
    fireEvent.click(screen.getByRole('button', { name: '成果 · 2' }))
    expect(await screen.findByText('project')).toBeVisible()
  })
  it('shows an empty panel after changing to a conversation without outputs', async () => {
    const { rerender } = render(<SessionDeliverables key="one" topicId="agent-session:one" />)
    mocks.messages = []
    rerender(<SessionDeliverables key="two" topicId="agent-session:two" />)
    fireEvent.click(screen.getByRole('button', { name: '成果 · 0' }))
    expect(await screen.findByText('本会话暂无已登记成果。')).toBeVisible()
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('labels missing history, disables shell actions, and enables restored paths after refresh', async () => {
    mocks.check.mockImplementation(async (paths: string[]) =>
      paths.map((path) => ({ path, status: path.endsWith('.xlsx') ? 'missing' : 'available' }))
    )
    render(<SessionDeliverables topicId="agent-session:one" />)
    fireEvent.click(screen.getByRole('button', { name: '成果 · 2' }))
    expect(await screen.findByText('文件已移动或删除')).toBeVisible()
    expect(screen.getByRole('button', { name: '成果 · 1' })).toBeVisible()
    expect(screen.getByRole('button', { name: '定位文件' })).toBeDisabled()
    fireEvent.click(screen.getAllByRole('button', { name: /打\s*开/ })[1])
    expect(mocks.open).not.toHaveBeenCalled()
    mocks.check.mockImplementation(async (paths: string[]) => paths.map((path) => ({ path, status: 'available' })))
    fireEvent.click(screen.getByRole('button', { name: /刷\s*新/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: '定位文件' })).toBeEnabled())
    expect(screen.queryByText('文件已移动或删除')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '成果 · 2' })).toBeVisible()
  })

  it('does not apply an old conversation check result to a new conversation', async () => {
    let finishOld!: (value: { path: string; status: string }[]) => void
    mocks.check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        })
    )
    const { rerender } = render(<SessionDeliverables topicId="agent-session:one" />)
    fireEvent.click(screen.getByRole('button', { name: '成果 · 2' }))
    await screen.findByText('report.xlsx')
    mocks.messages = []
    rerender(<SessionDeliverables topicId="agent-session:two" />)
    finishOld([{ path: 'C:/output/report.xlsx', status: 'missing' }])
    expect(await screen.findByText('本会话暂无已登记成果。')).toBeVisible()
    expect(screen.queryByText('文件已移动或删除')).not.toBeInTheDocument()
  })
})
