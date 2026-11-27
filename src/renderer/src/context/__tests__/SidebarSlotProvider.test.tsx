import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, SECOND_MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarBodySlot, SidebarSlotProvider, useSidebarCreateAction, useSidebarShell } from '../SidebarSlotProvider'

vi.mock('@renderer/config/constant', () => ({ isMac: false }))
vi.mock('@renderer/hooks/useShortcuts', () => ({ useShortcut: vi.fn() }))

const setMinimumSize = vi.fn().mockResolvedValue(undefined)
const createTask = vi.fn()
const createConversation = vi.fn()
const ipcOn = vi.fn(() => vi.fn())

function Harness() {
  const shell = useSidebarShell()
  if (!shell) return null
  return (
    <>
      <div data-testid="sidebar" ref={shell.setBodySlot} data-collapsed={shell.collapsed} />
      <button type="button" onClick={shell.toggleSidebar}>
        Toggle
      </button>
      <button type="button" onClick={shell.requestCreate}>
        Create
      </button>
      <Link to="/">Chat</Link>
      <Link to="/paintings">Paintings</Link>
      <Routes>
        <Route path="/" element={<Page title="Conversation list" create={createConversation} />} />
        <Route path="/new-assistant" element={<Page title="Task list" create={createTask} />} />
        <Route path="/paintings" element={<p>Image Canvas</p>} />
      </Routes>
    </>
  )
}

function Page({ title, create }: { title: string; create: () => void }) {
  useSidebarCreateAction(create)
  return <SidebarBodySlot>{title}</SidebarBodySlot>
}

function mount(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarSlotProvider>
        <Harness />
      </SidebarSlotProvider>
    </MemoryRouter>
  )
}

describe('SidebarSlotProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('api', { window: { setMinimumSize } })
    vi.stubGlobal('electron', { ipcRenderer: { on: ipcOn } })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('portals the active list and maintains separate sidebar widths for Paintings', () => {
    mount()
    const sidebar = screen.getByTestId('sidebar')
    expect(sidebar).toHaveTextContent('Conversation list')
    expect(setMinimumSize).toHaveBeenLastCalledWith(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)

    fireEvent.click(screen.getByRole('link', { name: 'Paintings' }))
    expect(sidebar).toHaveAttribute('data-collapsed', 'true')
    expect(sidebar).not.toHaveTextContent('Conversation list')
    expect(setMinimumSize).toHaveBeenLastCalledWith(SECOND_MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)

    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
    fireEvent.click(screen.getByRole('link', { name: 'Chat' }))
    fireEvent.keyDown(window, { code: 'KeyB', ctrlKey: true })
    expect(sidebar).toHaveAttribute('data-collapsed', 'true')

    fireEvent.keyDown(window, { code: 'KeyB', ctrlKey: true, repeat: true })
    expect(sidebar).toHaveAttribute('data-collapsed', 'true')
    fireEvent.click(screen.getByRole('link', { name: 'Paintings' }))
    expect(sidebar).toHaveAttribute('data-collapsed', 'false')
    expect(ipcOn).toHaveBeenCalledWith(IpcChannel.Windows_ToggleSidebar, expect.any(Function))
  })

  it('uses the chat action in Chat and creates a task after switching from another page', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(createConversation).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('link', { name: 'Paintings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByTestId('sidebar')).toHaveTextContent('Task list')
    expect(createTask).toHaveBeenCalledTimes(1)
  })
})
