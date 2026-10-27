import type { Message, MessageBlock, ToolMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  messages: [] as Message[],
  state: { messageBlocks: { entities: {} as Record<string, MessageBlock> } },
  check: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
  toast: vi.fn()
}))
vi.mock('@renderer/store', () => ({ useAppSelector: (selector: any) => selector(mocks.state) }))
vi.mock('@renderer/hooks/useMessageOperations', () => ({ useTopicMessages: () => mocks.messages }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

import { collectMessageArtifacts, collectSessionArtifacts } from '../artifactShortcuts'
import MessageArtifacts from '../MessageArtifacts'

const outputBlock = (id: string, response: unknown, name = 'mcp__assistant__present_files'): ToolMessageBlock =>
  ({
    id,
    messageId: 'reply',
    type: MessageBlockType.TOOL,
    status: MessageBlockStatus.SUCCESS,
    createdAt: '',
    toolId: id,
    metadata: { rawMcpToolResponse: { id, tool: { id: name, name, type: 'builtin' }, status: 'done', response } }
  }) as ToolMessageBlock
const result = { status: 'ready', files: [{ path: 'C:\\output\\report.xlsx', verified: true }] }
const message = { id: 'reply', role: 'assistant', blocks: ['created', 'presented'] } as Message

beforeEach(() => {
  vi.clearAllMocks()
  mocks.messages = []
  mocks.check
    .mockReset()
    .mockImplementation(async (paths: string[]) => paths.map((path) => ({ path, status: 'available' })))
  mocks.open.mockResolvedValue(undefined)
  mocks.reveal.mockResolvedValue(undefined)
  Object.assign(window, {
    api: { file: { openPath: mocks.open, showInFolder: mocks.reveal, checkPaths: mocks.check } },
    toast: { error: mocks.toast }
  })
  mocks.state.messageBlocks.entities = {
    created: outputBlock(
      'created',
      { status: 'created', path: 'C:/output/report.xlsx' },
      'mcp__assistant__create_file'
    ),
    presented: outputBlock('presented', { content: [{ type: 'text', text: JSON.stringify(result) }] })
  }
})

describe('persistent deliverable shortcuts', () => {
  it('aggregates only current conversation output blocks, deduplicates paths and points to the latest source', () => {
    const messages = [
      { id: 'u1', role: 'user', blocks: ['input'] },
      { ...message, id: 'first', blocks: ['created'] },
      { id: 'u2', role: 'user', blocks: [] },
      { ...message, id: 'latest', blocks: ['presented'] }
    ] as Message[]
    mocks.state.messageBlocks.entities.input = outputBlock('input', result)
    mocks.state.messageBlocks.entities.otherConversation = outputBlock('otherConversation', {
      files: [{ path: '/other/private.xlsx' }]
    })
    const entries = collectSessionArtifacts(messages, mocks.state.messageBlocks.entities)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ path: 'C:\\output\\report.xlsx', messageId: 'latest', turn: 2, occurrences: 2 })
    expect(collectSessionArtifacts(messages.slice(0, 2), mocks.state.messageBlocks.entities)[0]).toMatchObject({
      messageId: 'first',
      turn: 1,
      occurrences: 1
    })
    expect(collectSessionArtifacts([], mocks.state.messageBlocks.entities)).toEqual([])
  })
  it('deduplicates create/present outputs and restores shortcuts from persisted blocks on remount', async () => {
    const { unmount } = render(<MessageArtifacts message={message} />)
    expect(await screen.findAllByRole('button', { name: 'report.xlsx' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'report.xlsx' }))
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith('C:\\output\\report.xlsx'))
    fireEvent.click(screen.getByRole('button', { name: 'message.tools.assistantCreateFile.open_folder' }))
    await waitFor(() => expect(mocks.reveal).toHaveBeenCalledWith('C:\\output\\report.xlsx'))
    unmount()
    mocks.state = JSON.parse(JSON.stringify(mocks.state))
    render(<MessageArtifacts message={message} />)
    expect(await screen.findByRole('button', { name: 'report.xlsx' })).toBeVisible()
    expect(screen.queryByText('工具')).not.toBeInTheDocument()
  })
  it('opens a registered folder directly, without pretending it is a file', async () => {
    mocks.state.messageBlocks.entities.created = outputBlock('created', {
      status: 'ready',
      files: [{ path: '/Users/test/project', kind: 'directory' }]
    })
    render(<MessageArtifacts message={{ ...message, blocks: ['created'] }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'project' }))
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith('/Users/test/project'))
    expect(mocks.reveal).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
  it('does not promote input/read paths, incomplete, failed, unsafe or relative results', () => {
    const failed = outputBlock('failed', result)
    failed.metadata!.rawMcpToolResponse!.status = 'error'
    const pending = outputBlock('pending', result)
    pending.metadata!.rawMcpToolResponse!.status = 'invoking'
    expect(
      collectMessageArtifacts([
        failed,
        pending,
        outputBlock('read', result, 'Read'),
        outputBlock('error', { isError: true, ...result }),
        outputBlock('cancelled', { status: 'cancelled', files: result.files }),
        outputBlock('relative', {
          files: [
            { path: '../secret' },
            { path: 'https://example.com/file' },
            { path: '//server/share/a.exe' },
            { path: 'C:\\output\\bad\nfile' }
          ]
        }),
        { ...outputBlock('block-failed', result), status: MessageBlockStatus.ERROR }
      ])
    ).toEqual([])
    expect(render(<MessageArtifacts message={{ ...message, role: 'user' }} />).container).toBeEmptyDOMElement()
  })
  it('preserves distinct case-sensitive Unix outputs', () => {
    expect(
      collectMessageArtifacts([
        outputBlock('case', { files: [{ path: '/tmp/Report.md' }, { path: '/tmp/report.md' }] })
      ])
    ).toHaveLength(2)
  })
  it('retains original/output and backup shortcuts, not a failed replacement', () => {
    expect(
      collectMessageArtifacts([
        outputBlock(
          'copy',
          { status: 'created', path: '/tmp/report.txt', backup_path: '/tmp/.zen-backups/report-1.txt' },
          'mcp__assistant__create_file'
        )
      ]).map((item) => item.path)
    ).toEqual(['/tmp/report.txt', '/tmp/.zen-backups/report-1.txt'])
    expect(
      collectMessageArtifacts([
        outputBlock(
          'backup',
          { status: 'backup-created', original_path: '/tmp/report.txt', backup_path: '/tmp/.zen-backups/report-1.txt' },
          'mcp__assistant__backup_file'
        )
      ]).map((item) => item.path)
    ).toEqual(['/tmp/.zen-backups/report-1.txt'])
    expect(
      collectMessageArtifacts([
        outputBlock(
          'rejected',
          { isError: true, backup_path: '/tmp/.zen-backups/report-1.txt' },
          'mcp__assistant__create_file'
        )
      ])
    ).toEqual([])
  })
  it('reports an application-open failure without losing an existing saved shortcut', async () => {
    mocks.open.mockRejectedValue(new Error('missing file'))
    render(<MessageArtifacts message={message} />)
    fireEvent.click(await screen.findByRole('button', { name: 'report.xlsx' }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'report.xlsx' })).toBeVisible()
  })

  it('publishes exactly seven final files and a folder after regenerating the PDF', () => {
    const files = [
      '项目说明.docx',
      '项目预算表.xlsx',
      '项目汇报.pptx',
      '项目报告.pdf',
      '项目数据.json',
      '项目说明.txt',
      '费用明细.csv'
    ].map((name) => ({ path: `C:/output/手工验收7319/${name}` }))
    files.push({ path: 'C:/output/手工验收7319' })
    const draft = outputBlock(
      'draft',
      { status: 'created', path: 'C:/output/手工验收7319/项目报告.pdf' },
      'create_file'
    )
    const retry = outputBlock(
      'retry',
      { status: 'created', path: 'C:/output/手工验收7319/项目报告 (1).pdf' },
      'create_file'
    )
    const final = outputBlock('final', {
      content: [{ type: 'text', text: JSON.stringify({ status: 'ready', final: true, files }) }]
    })
    expect(collectMessageArtifacts([draft, retry, final]).map((item) => item.path)).toEqual(
      files.map((item) => item.path)
    )
    // Ordinary, partial registrations remain additive; numbered filenames can be legitimate outputs.
    expect(
      collectMessageArtifacts([draft, retry, outputBlock('batch', { files: [{ path: '/tmp/other.txt' }] })])
    ).toHaveLength(3)
    expect(collectMessageArtifacts([draft, retry, { ...final, status: MessageBlockStatus.ERROR }])).toHaveLength(2)
    expect(
      collectMessageArtifacts([
        draft,
        outputBlock('unsafe', { status: 'ready', final: true, files: [{ path: '../bad' }] })
      ])
    ).toHaveLength(1)
  })

  it('replaces intermediate messages only within their user turn and preserves earlier deliveries', async () => {
    const blocks = {
      earlier: outputBlock('earlier', { files: [{ path: '/tmp/earlier.pdf' }] }),
      draft: outputBlock('draft', { status: 'created', path: '/tmp/report (1).pdf' }, 'create_file'),
      final: outputBlock('final', { status: 'ready', final: true, files: [{ path: '/tmp/report.pdf' }] })
    }
    const messages = [
      { id: 'u0', role: 'user', blocks: [] },
      { ...message, id: 'old', blocks: ['earlier'] },
      { id: 'u1', role: 'user', blocks: [] },
      { ...message, id: 'draft', blocks: ['draft'] },
      { ...message, id: 'final', blocks: ['final'] }
    ] as Message[]
    mocks.messages = messages
    mocks.state.messageBlocks.entities = blocks
    expect(collectSessionArtifacts(messages, blocks).map((item) => item.path)).toEqual([
      '/tmp/report.pdf',
      '/tmp/earlier.pdf'
    ])
    const { container } = render(<MessageArtifacts message={messages[3]} />)
    expect(container).toBeEmptyDOMElement()
    render(<MessageArtifacts message={messages[4]} />)
    expect(await screen.findByRole('button', { name: 'report.pdf' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'report (1).pdf' })).not.toBeInTheDocument()
  })

  it('removes a missing legacy PDF shortcut on load and after remount without editing history', async () => {
    mocks.state.messageBlocks.entities.retry = outputBlock(
      'retry',
      { status: 'created', path: 'C:/output/report (1).pdf' },
      'create_file'
    )
    const legacyMessage = { ...message, blocks: ['created', 'retry', 'presented'] }
    mocks.check.mockImplementation(async (paths: string[]) =>
      paths.map((path) => ({ path, status: path.includes('(1)') ? 'missing' : 'available' }))
    )
    const { unmount } = render(<MessageArtifacts message={legacyMessage} />)
    expect(await screen.findByRole('button', { name: 'report.xlsx' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'report (1).pdf' })).not.toBeInTheDocument()
    expect(mocks.state.messageBlocks.entities.retry).toBeDefined()
    unmount()
    render(<MessageArtifacts message={legacyMessage} />)
    expect(await screen.findByRole('button', { name: 'report.xlsx' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'report (1).pdf' })).not.toBeInTheDocument()
  })

  it('checks again at click time and never calls the shell for a file deleted after display', async () => {
    render(<MessageArtifacts message={message} />)
    const button = await screen.findByRole('button', { name: 'report.xlsx' })
    mocks.check.mockResolvedValueOnce([{ path: 'C:\\output\\report.xlsx', status: 'missing' }])
    fireEvent.click(button)
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('chat.input.tools.file_not_found'))
    expect(mocks.open).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'report.xlsx' })).not.toBeInTheDocument()
  })

  it('rechecks a regenerated output at the same path without requiring window focus', async () => {
    mocks.check.mockImplementation(async (paths: string[]) => paths.map((path) => ({ path, status: 'missing' })))
    const { rerender } = render(<MessageArtifacts message={message} />)
    await waitFor(() => expect(mocks.check).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'report.xlsx' })).not.toBeInTheDocument()
    mocks.check.mockImplementation(async (paths: string[]) => paths.map((path) => ({ path, status: 'available' })))
    mocks.state.messageBlocks.entities.regenerated = outputBlock('regenerated', result)
    rerender(<MessageArtifacts message={{ ...message, blocks: ['regenerated'] }} />)
    expect(await screen.findByRole('button', { name: 'report.xlsx' })).toBeVisible()
  })

  it('shows check failures as unavailable and refreshes restored files on window focus', async () => {
    mocks.check.mockImplementationOnce(() => {
      throw new Error('IPC unavailable')
    })
    render(<MessageArtifacts message={message} />)
    expect(await screen.findByText('assistantDeliverables.unavailable')).toBeVisible()
    expect(screen.getByRole('button', { name: /report.xlsx/ })).toBeDisabled()
    fireEvent(window, new Event('focus'))
    expect(await screen.findByRole('button', { name: 'report.xlsx' })).toBeEnabled()
  })
})
