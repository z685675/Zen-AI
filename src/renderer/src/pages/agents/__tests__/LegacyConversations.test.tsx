import { AgentWorkspaceContext, useAgentWorkspace } from '@renderer/context/AgentWorkspaceProvider'
import { getLegacyConversationPath, LEGACY_CONVERSATIONS_PATH } from '@renderer/utils/legacyConversations'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { type ReactNode, useReducer } from 'react'
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  models: [] as string[],
  currentSessions: [] as { id: string; agent_id: string; name: string }[],
  legacySessions: [] as {
    id: string
    agent_id: string
    name: string
    is_archived?: boolean
    configuration?: { folder: string }
  }[],
  legacyHasMore: true,
  client: {
    listChannels: vi.fn().mockResolvedValue({ data: [] }),
    listAllSessions: vi.fn(),
    deleteSession: vi.fn(),
    getSessionPaths: (agentId: string) => ({
      withId: (sessionId: string) => `/agents/${agentId}/sessions/${sessionId}`
    })
  },
  confirm: vi.fn<(options: { onOk: () => Promise<void> }) => void>(),
  toastError: vi.fn(),
  reload: vi.fn().mockResolvedValue(undefined),
  dispatch: vi.fn().mockResolvedValue(undefined),
  loadMore: vi.fn(),
  restore: vi.fn(),
  sessions: vi.fn(),
  setActiveAgentId: vi.fn(),
  continueInNew: vi.fn()
}))

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@renderer/components/app/Navbar', () => ({
  Navbar: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  NavbarCenter: ({ children }: React.PropsWithChildren) => <div>{children}</div>
}))
vi.mock('@renderer/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: React.PropsWithChildren) => <>{children}</>
}))
vi.mock('@renderer/components/DraggableList/virtual-list', () => ({
  default: ({
    list,
    children,
    header
  }: {
    list: { id: string }[]
    children: (session: { id: string }) => ReactNode
    header?: ReactNode
  }) => (
    <section aria-label="Session list">
      {header}
      {list.map((session) => (
        <div key={session.id}>{children(session)}</div>
      ))}
    </section>
  )
}))
vi.mock('@renderer/components/ModelSetupGuide', () => ({ default: () => <div>Configure a model</div> }))
vi.mock('@renderer/components/QuickPanel', () => ({
  QuickPanelProvider: ({ children }: React.PropsWithChildren) => <>{children}</>
}))
vi.mock('@renderer/hooks/agents/useActiveAgent', () => ({
  useActiveAgent: () => ({ setActiveAgentId: mocks.setActiveAgentId })
}))
vi.mock('@renderer/hooks/agents/useAgents', () => ({
  useAgents: () => ({ agents: [{ id: DEFAULT_OPENCODE_AGENT_ID }] })
}))
vi.mock('@renderer/hooks/agents/useAllSessions', () => ({
  useAllSessions: (options: unknown) => {
    const workspace = useAgentWorkspace()
    const [, refresh] = useReducer((revision: number) => revision + 1, 0)
    mocks.sessions(workspace, options)
    if (workspace === 'opencode') {
      return { sessions: mocks.currentSessions }
    }
    return {
      sessions: mocks.legacySessions.slice(0, 20),
      total: mocks.legacySessions.length,
      hasMore: mocks.legacyHasMore,
      loadMore: mocks.loadMore,
      reload: async () => {
        await mocks.reload()
        refresh()
      }
    }
  }
}))
vi.mock('@renderer/hooks/agents/useAgentClient', () => ({ useAgentClient: () => mocks.client }))
vi.mock('@renderer/hooks/agents/useCreateDefaultSession', () => ({
  useCreateDefaultSession: () => ({ canCreateSession: false })
}))
vi.mock('@renderer/hooks/agents/useLegacyContinuation', () => ({
  useLegacyContinuation: () => ({ continueInNew: mocks.continueInNew })
}))
vi.mock('@renderer/hooks/agents/useRestoreAgentSession', () => ({ useRestoreAgentSession: mocks.restore }))
vi.mock('@renderer/hooks/agents/useSession', () => ({
  useSession: (_agentId: string, id: string) => ({ session: { id, name: 'Opened old conversation' } })
}))
vi.mock('@renderer/hooks/useApiServer', () => ({
  useApiServer: () => ({ apiServerRunning: true, apiServerConfig: { enabled: true } })
}))
vi.mock('@renderer/hooks/useRuntime', () => ({
  useRuntime: () => ({ chat: { activeAgentId: DEFAULT_OPENCODE_AGENT_ID, activeSessionIdMap: {} } })
}))
vi.mock('@renderer/hooks/useSettings', () => ({ useNavbarPosition: () => ({}), useSettings: () => ({}) }))
vi.mock('@renderer/hooks/useShortcuts', () => ({ useShortcut: vi.fn(), useShortcutDisplay: vi.fn() }))
vi.mock('@renderer/hooks/useStore', () => ({ useShowAssistants: () => ({ showAssistants: true }) }))
vi.mock('@renderer/services/db/DbService', () => ({ DbService: { getInstance: () => ({}) } }))
vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: (select: (state: unknown) => unknown) =>
    select({
      llm: { providers: mocks.models },
      messages: {
        loadedByTopic: { 'agent-session:old-archived': true },
        messageIdsByTopic: { 'agent-session:old-archived': ['original-message'] }
      }
    })
}))
vi.mock('@renderer/store/thunk/messageThunk', () => ({ loadTopicMessagesThunk: (topicId: string) => topicId }))
vi.mock('@renderer/utils', () => ({ cn: (...values: Array<string | undefined>) => values.filter(Boolean).join(' ') }))
vi.mock('@renderer/utils/modelAvailability', () => ({ getAvailableChatModels: (providers: string[]) => providers }))
vi.mock('../../home/Messages/ChatNavigation', () => ({ default: () => null }))
vi.mock('../AgentChat', () => ({ default: () => <div>Smart Assistant chat</div> }))
vi.mock('../AgentNavbar', () => ({ default: () => null }))
vi.mock('../components/Agents', () => ({ default: () => null }))
vi.mock('../components/AgentSessionMessages', () => ({
  default: ({ sessionId }: { sessionId: string }) => <div>Original messages from {sessionId}</div>
}))
vi.mock('../components/SessionItem', () => ({
  default: ({ onPress, session, readOnly }: { onPress: () => void; session: { name: string }; readOnly: boolean }) => (
    <button type="button" onClick={onPress} data-read-only={readOnly}>
      {session.name}
    </button>
  )
}))

import AgentPage from '../AgentPage'

function renderAssistant(path = '/new-assistant') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/agents" element={<Navigate to={LEGACY_CONVERSATIONS_PATH} replace />} />
        <Route
          path="/new-assistant"
          element={
            <AgentWorkspaceContext value="opencode">
              <AgentPage />
            </AgentWorkspaceContext>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  mocks.models = []
  mocks.currentSessions = [{ id: 'new-session', agent_id: DEFAULT_OPENCODE_AGENT_ID, name: 'New conversation' }]
  mocks.legacyHasMore = true
  mocks.legacySessions = [
    { id: 'old-active', agent_id: 'legacy-a', name: 'Old active', configuration: { folder: 'First folder' } },
    {
      id: 'old-archived',
      agent_id: 'legacy-b',
      name: 'Old archived',
      is_archived: true,
      configuration: { folder: 'Second folder' }
    }
  ]
  vi.clearAllMocks()
  mocks.client.listAllSessions.mockImplementation(async ({ offset, limit }) => ({
    data: mocks.legacySessions.slice(offset, offset + limit),
    total: mocks.legacySessions.length
  }))
  mocks.client.deleteSession.mockImplementation(async (agentId: string, sessionId: string) => {
    mocks.legacySessions = mocks.legacySessions.filter(
      (session) => session.id !== sessionId || session.agent_id !== agentId
    )
  })
  vi.stubGlobal('modal', { confirm: mocks.confirm })
  vi.stubGlobal('toast', { error: mocks.toastError })
  vi.stubGlobal('api', { window: { setMinimumSize: vi.fn(), resetMinimumSize: vi.fn() } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('old conversations in Smart Assistant', () => {
  it('opens a flat list of active and archived legacy conversations and reads original history without a model', async () => {
    renderAssistant()
    expect(screen.getByText('Configure a model')).toBeInTheDocument()
    const list = within(screen.getByRole('region', { name: 'Session list' }))
    const current = list.getByRole('button', { name: 'New conversation' })
    const folder = list.getByRole('button', { name: 'assistant_transition.legacy_history' })
    expect(list.getAllByRole('button')).toEqual([
      folder,
      list.getByRole('button', { name: 'assistant_transition.delete_legacy_folder' }),
      current
    ])
    expect(folder).toHaveAttribute('aria-expanded', 'false')
    expect(list.queryByRole('button', { name: 'Old archived' })).not.toBeInTheDocument()
    fireEvent.click(folder)

    const oldArchived = await list.findByRole('button', { name: 'Old archived' })
    expect(list.getAllByRole('button')[0]).toBe(folder)
    expect(oldArchived.compareDocumentPosition(current)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(current).toBeVisible()
    expect(folder).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Old active' })).toHaveAttribute('data-read-only', 'true')
    expect(screen.queryByText(/First folder|Second folder/)).not.toBeInTheDocument()
    expect(mocks.sessions).toHaveBeenCalledWith('legacy', { archived: 'include', enabled: true })
    fireEvent.click(screen.getByRole('button', { name: 'assistant_transition.load_more_history' }))
    expect(mocks.loadMore).toHaveBeenCalledOnce()

    fireEvent.click(oldArchived)
    expect(await screen.findByText('Original messages from old-archived')).toBeInTheDocument()
    expect(mocks.dispatch).toHaveBeenCalledWith('agent-session:old-archived')
    expect(mocks.setActiveAgentId).not.toHaveBeenCalled()
    expect(mocks.continueInNew).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'assistant_transition.continue' }))
    expect(mocks.continueInNew).toHaveBeenCalledOnce()

    fireEvent.click(folder)
    expect(list.queryByRole('button', { name: 'Old archived' })).not.toBeInTheDocument()
    expect(current).toBeVisible()
    expect(screen.getByText('Configure a model')).toBeInTheDocument()
  })

  it('opens historical links while keeping regular Smart Assistant conversations available', async () => {
    mocks.models = ['available-model']
    renderAssistant(getLegacyConversationPath({ agentId: 'legacy-b', sessionId: 'old-archived' }))
    expect(await screen.findByText('Original messages from old-archived')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    expect(await screen.findByText('Smart Assistant chat')).toBeInTheDocument()
  })

  it('opens the folder from the retired entry address', async () => {
    mocks.currentSessions = []
    renderAssistant('/agents')
    expect(await screen.findByRole('button', { name: 'Old active' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'assistant_transition.legacy_history' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('asks before deleting a single conversation and leaves the others visible', async () => {
    renderAssistant(getLegacyConversationPath({ agentId: 'legacy-b', sessionId: 'old-archived' }))
    expect(await screen.findByText('Original messages from old-archived')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'agent.session.delete.title · Old archived' }))

    expect(mocks.client.deleteSession).not.toHaveBeenCalled()
    await act(() => mocks.confirm.mock.calls[0][0].onOk())

    expect(mocks.client.deleteSession.mock.calls).toEqual([['legacy-b', 'old-archived']])
    expect(screen.queryByRole('button', { name: 'Old archived' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Old active' })).toBeVisible()
    expect(screen.getByText('assistant_transition.select_history')).toBeInTheDocument()
  })

  it('returns to the new assistant after the last old conversation is deleted', async () => {
    mocks.legacySessions = mocks.legacySessions.slice(0, 1)
    mocks.models = ['available-model']
    renderAssistant(getLegacyConversationPath({ agentId: 'legacy-a', sessionId: 'old-active' }))
    fireEvent.click(screen.getByRole('button', { name: 'agent.session.delete.title · Old active' }))
    await act(() => mocks.confirm.mock.calls[0][0].onOk())

    expect(screen.queryByRole('button', { name: 'assistant_transition.legacy_history' })).not.toBeInTheDocument()
    expect(screen.getByText('Smart Assistant chat')).toBeInTheDocument()
  })

  it('deletes all pages of old conversations before removing the folder', async () => {
    for (let i = 0; i < 21; i++) {
      mocks.legacySessions.push({ id: `another-${i}`, agent_id: 'legacy-a', name: `Old chat ${i}`, is_archived: true })
    }
    renderAssistant()
    fireEvent.click(screen.getByRole('button', { name: 'assistant_transition.delete_legacy_folder' }))

    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'assistant_transition.delete_legacy_folder_confirm' })
    )
    expect(mocks.client.listAllSessions).not.toHaveBeenCalled()
    expect(mocks.client.deleteSession).not.toHaveBeenCalled()
    await act(() => mocks.confirm.mock.calls[0][0].onOk())

    expect(mocks.client.listAllSessions.mock.calls.map(([request]) => request)).toEqual([
      { archived: 'include', limit: 20, offset: 0 },
      { archived: 'include', limit: 20, offset: 20 },
      { archived: 'include', limit: 1, offset: 0 }
    ])
    expect(mocks.client.deleteSession).toHaveBeenCalledTimes(23)
    expect(mocks.client.deleteSession).toHaveBeenCalledWith('legacy-a', 'another-20')
    expect(mocks.client.deleteSession).not.toHaveBeenCalledWith(DEFAULT_OPENCODE_AGENT_ID, expect.anything())
    expect(screen.queryByRole('button', { name: 'assistant_transition.legacy_history' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeVisible()
  })

  it('keeps the folder available when a conversation could not be deleted', async () => {
    mocks.client.deleteSession.mockRejectedValueOnce(new Error('Conversation is busy'))
    renderAssistant(LEGACY_CONVERSATIONS_PATH)
    fireEvent.click(screen.getByRole('button', { name: 'assistant_transition.delete_legacy_folder' }))
    await act(() => mocks.confirm.mock.calls[0][0].onOk())

    expect(mocks.toastError).toHaveBeenCalledWith('assistant_transition.delete_legacy_folder_failed')
    expect(screen.getByRole('button', { name: 'assistant_transition.legacy_history' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Old active' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Old archived' })).not.toBeInTheDocument()
  })

  it('does not delete anything if the old-history response contains a new assistant session', async () => {
    mocks.legacySessions.push({ id: 'new-session', agent_id: DEFAULT_OPENCODE_AGENT_ID, name: 'New conversation' })
    renderAssistant()
    fireEvent.click(screen.getByRole('button', { name: 'assistant_transition.delete_legacy_folder' }))
    await act(() => mocks.confirm.mock.calls[0][0].onOk())

    expect(mocks.client.deleteSession).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('assistant_transition.delete_legacy_folder_failed')
  })
})
