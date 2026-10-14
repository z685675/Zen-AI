import type { Message, MessageBlock, ToolMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: { messageBlocks: { entities: {} as Record<string, MessageBlock> } },
  open: vi.fn(),
  reveal: vi.fn(),
  toast: vi.fn()
}))
vi.mock('@renderer/store', () => ({ useAppSelector: (selector: any) => selector(mocks.state) }))
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
  mocks.open.mockResolvedValue(undefined)
  mocks.reveal.mockResolvedValue(undefined)
  Object.assign(window, {
    api: { file: { openPath: mocks.open, showInFolder: mocks.reveal } },
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
  it('deduplicates create/present outputs and restores shortcuts from persisted blocks on remount', () => {
    const { unmount } = render(<MessageArtifacts message={message} />)
    expect(screen.getAllByRole('button', { name: 'report.xlsx' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'report.xlsx' }))
    expect(mocks.open).toHaveBeenCalledWith('C:\\output\\report.xlsx')
    fireEvent.click(screen.getByRole('button', { name: 'message.tools.assistantCreateFile.open_folder' }))
    expect(mocks.reveal).toHaveBeenCalledWith('C:\\output\\report.xlsx')
    unmount()
    mocks.state = JSON.parse(JSON.stringify(mocks.state))
    render(<MessageArtifacts message={message} />)
    expect(screen.getByRole('button', { name: 'report.xlsx' })).toBeVisible()
    expect(screen.queryByText('工具')).not.toBeInTheDocument()
  })
  it('opens a registered folder directly, without pretending it is a file', () => {
    mocks.state.messageBlocks.entities.created = outputBlock('created', {
      status: 'ready',
      files: [{ path: '/Users/test/project', kind: 'directory' }]
    })
    render(<MessageArtifacts message={{ ...message, blocks: ['created'] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'project' }))
    expect(mocks.open).toHaveBeenCalledWith('/Users/test/project')
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
  it('reports a moved or deleted deliverable without losing the saved shortcut', async () => {
    mocks.open.mockRejectedValue(new Error('missing file'))
    render(<MessageArtifacts message={message} />)
    fireEvent.click(screen.getByRole('button', { name: 'report.xlsx' }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'report.xlsx' })).toBeVisible()
  })
})
