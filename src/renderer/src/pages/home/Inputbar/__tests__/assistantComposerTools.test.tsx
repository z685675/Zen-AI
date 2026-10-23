import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openResource: vi.fn(),
  useResourcePanel: vi.fn(),
  selectFiles: vi.fn(),
  setFiles: vi.fn(),
  setText: vi.fn(),
  filterFiles: vi.fn()
}))

vi.mock('@renderer/components/QuickPanel', () => ({
  QuickPanelReservedSymbol: { Root: '/', SlashCommands: 'slash-commands' }
}))
vi.mock('@renderer/pages/home/Inputbar/tools/components/QuickPhrasesButton', () => ({
  default: () => <button type="button">saved-phrases</button>
}))
vi.mock('@renderer/pages/home/Inputbar/tools/components/SlashCommandsButton', () => ({ default: () => null }))
vi.mock('@renderer/pages/home/Inputbar/tools/components/useResourcePanel', () => ({
  useResourcePanel: mocks.useResourcePanel
}))
vi.mock('@renderer/utils/file', () => ({ filterSupportedFiles: mocks.filterFiles }))
vi.mock('antd', () => ({
  Popover: ({ children, content, open, onOpenChange }: any) => (
    <>
      <span role="presentation" onClick={() => onOpenChange(!open)}>
        {children}
      </span>
      {open && content}
    </>
  )
}))

import type { Assistant, FileMetadata } from '@renderer/types'

import quickPhrasesTool from '../tools/quickPhrasesTool'
import sessionMoreTool from '../tools/sessionMoreTool'
import slashCommandsTool from '../tools/slashCommandsTool'
import { getToolsForScope, TopicType } from '../types'

const newAssistant = { id: DEFAULT_OPENCODE_AGENT_ID } as Assistant
const MoreMenu = sessionMoreTool.render!

function context(paths = ['/workspace']) {
  return {
    scope: TopicType.Session,
    assistant: newAssistant,
    session: {
      agentId: DEFAULT_OPENCODE_AGENT_ID,
      accessiblePaths: paths,
      // Stale imported configuration must not reintroduce an old command.
      slashCommands: [{ command: '/compact' }]
    },
    t: (key: string) => key,
    quickPanel: { registerRootMenu: vi.fn(), registerTrigger: vi.fn() },
    quickPanelController: { open: vi.fn(), close: vi.fn() },
    state: { files: [{ id: 'existing' }], extensions: ['.pdf', '.png'], couldAddImageFile: true },
    actions: { setFiles: mocks.setFiles, onTextChange: mocks.setText }
  } as unknown as Parameters<typeof MoreMenu>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useResourcePanel.mockReturnValue({ handleOpenQuickPanel: mocks.openResource })
  mocks.selectFiles.mockResolvedValue(null)
  window.api.file.select = mocks.selectFiles
})

describe('new assistant composer tool boundary', () => {
  it('excludes phrases and commands from registration even with stale session commands', () => {
    const value = context()
    const available = getToolsForScope(TopicType.Session, value).map((tool) => tool.key)
    expect(available).toContain('session_more')
    expect(available).not.toContain(quickPhrasesTool.key)
    expect(available).not.toContain(slashCommandsTool.key)
    // The assistant ID also protects registration before optional session metadata arrives.
    expect(getToolsForScope(TopicType.Session, { assistant: newAssistant }).map((tool) => tool.key)).toEqual(available)
  })

  it('preserves phrase insertion in AI chat and the mini window, without changing saved data', () => {
    for (const scope of [TopicType.Chat, 'mini-window'] as const) {
      // Even the same ID in another input scope must not lose chat shortcuts.
      expect(getToolsForScope(scope, { assistant: newAssistant })).toContain(quickPhrasesTool)
    }
    expect(quickPhrasesTool.render).toBeTypeOf('function')
    expect(getToolsForScope(TopicType.Chat, { assistant: newAssistant })).not.toContain(sessionMoreTool)
  })

  it('shows only attachment and resource actions when opening More', () => {
    render(<MoreMenu {...context()} />)
    fireEvent.click(screen.getByRole('button', { name: 'chat.input.more.title' }))
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByRole('button', { name: /chat.input.upload.attachment/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /chat.input.resource_panel.title/ })).toBeEnabled()
    expect(screen.queryByText('settings.quickPhrase.title')).not.toBeInTheDocument()
    expect(screen.queryByText('chat.input.slash_commands.title')).not.toBeInTheDocument()
  })

  it('still opens a multi-file picker and appends selected attachments', async () => {
    const files = [
      { id: 'pdf', name: 'report.pdf' },
      { id: 'image', name: 'photo.png' }
    ] as FileMetadata[]
    mocks.selectFiles.mockResolvedValue(files)
    const value = context()
    render(<MoreMenu {...value} />)
    fireEvent.click(screen.getByRole('button', { name: 'chat.input.more.title' }))
    fireEvent.click(screen.getByRole('button', { name: /chat.input.upload.attachment/ }))
    await waitFor(() => expect(mocks.setFiles).toHaveBeenCalledWith([...value.state.files, ...files]))
    expect(mocks.selectFiles).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openFile', 'multiSelections'] })
    )
    expect(screen.queryByText('chat.input.more.attachment')).not.toBeInTheDocument()
    expect(mocks.openResource).not.toHaveBeenCalled()
  })

  it('leaves existing attachments untouched when the picker is cancelled', async () => {
    render(<MoreMenu {...context()} />)
    fireEvent.click(screen.getByRole('button', { name: 'chat.input.more.title' }))
    fireEvent.click(screen.getByRole('button', { name: /chat.input.upload.attachment/ }))
    await waitFor(() => expect(mocks.selectFiles).toHaveBeenCalledOnce())
    expect(mocks.setFiles).not.toHaveBeenCalled()
  })

  it('still opens the resource panel after closing More without changing the draft', async () => {
    const value = context()
    render(<MoreMenu {...value} />)
    fireEvent.click(screen.getByRole('button', { name: 'chat.input.more.title' }))
    fireEvent.click(screen.getByRole('button', { name: /chat.input.resource_panel.title/ }))
    await waitFor(() => expect(mocks.openResource).toHaveBeenCalledOnce())
    expect(mocks.useResourcePanel).toHaveBeenCalledWith(
      expect.objectContaining({ accessiblePaths: ['/workspace'], setText: mocks.setText }),
      'button'
    )
    expect(screen.queryByText('chat.input.more.resource_panel')).not.toBeInTheDocument()
    expect(mocks.setText).not.toHaveBeenCalled()
    expect(mocks.selectFiles).not.toHaveBeenCalled()
  })

  it('keeps the resource action disabled when no directory is available', () => {
    render(<MoreMenu {...context([])} />)
    fireEvent.click(screen.getByRole('button', { name: 'chat.input.more.title' }))
    const resource = screen.getByRole('button', { name: /chat.input.resource_panel.title/ })
    expect(resource).toBeDisabled()
    fireEvent.click(resource)
    expect(mocks.openResource).not.toHaveBeenCalled()
  })
})
