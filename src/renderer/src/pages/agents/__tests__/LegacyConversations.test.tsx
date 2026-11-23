import { AgentWorkspaceContext, useAgentWorkspace } from '@renderer/context/AgentWorkspaceProvider'
import { getLegacyConversationPath, LEGACY_CONVERSATIONS_PATH } from '@renderer/utils/legacyConversations'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { MemoryRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  models: [] as string[],
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
    mocks.sessions(useAgentWorkspace(), options)
    return {
      sessions: [
        { id: 'old-active', agent_id: 'legacy-a', name: 'Old active', configuration: { folder: 'First folder' } },
        {
          id: 'old-archived',
          agent_id: 'legacy-b',
          name: 'Old archived',
          is_archived: true,
          configuration: { folder: 'Second folder' }
        }
      ],
      hasMore: true,
      loadMore: mocks.loadMore
    }
  }
}))
vi.mock('@renderer/hooks/agents/useAgentClient', () => ({ useAgentClient: () => ({}) }))
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
  useRuntime: () => ({ chat: { activeAgentId: DEFAULT_OPENCODE_AGENT_ID } })
}))
vi.mock('@renderer/hooks/useSettings', () => ({ useNavbarPosition: () => ({}), useSettings: () => ({}) }))
vi.mock('@renderer/hooks/useShortcuts', () => ({ useShortcut: vi.fn() }))
vi.mock('@renderer/hooks/useStore', () => ({ useShowAssistants: () => ({ showAssistants: true }) }))
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
vi.mock('../components/GlobalSessions', () => ({ default: () => <div>New conversation list</div> }))
vi.mock('../components/SessionItem', () => ({
  default: ({ onPress, session, readOnly }: { onPress: () => void; session: { name: string }; readOnly: boolean }) => (
    <button type="button" onClick={onPress} data-read-only={readOnly}>
      {session.name}
    </button>
  )
}))

import AgentPage from '../AgentPage'

function NavigationBridge() {
  const navigate = useNavigate()
  useLayoutEffect(() => {
    vi.stubGlobal('navigate', navigate)
  }, [navigate])
  return null
}

function renderAssistant(path = '/new-assistant') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NavigationBridge />
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
  vi.clearAllMocks()
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
    const folder = screen.getByRole('button', { name: 'assistant_transition.legacy_history' })
    expect(folder).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(folder)

    const oldArchived = await screen.findByRole('button', { name: 'Old archived' })
    expect(folder).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Old active' })).toHaveAttribute('data-read-only', 'true')
    expect(screen.queryByText(/First folder|Second folder/)).not.toBeInTheDocument()
    expect(mocks.sessions).toHaveBeenCalledWith('legacy', { archived: 'include' })
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
    expect(await screen.findByText('New conversation list')).toBeInTheDocument()
    expect(screen.getByText('Configure a model')).toBeInTheDocument()
  })

  it('opens historical links while keeping regular Smart Assistant conversations available', async () => {
    mocks.models = ['available-model']
    renderAssistant(getLegacyConversationPath({ agentId: 'legacy-b', sessionId: 'old-archived' }))
    expect(await screen.findByText('Original messages from old-archived')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'assistant_transition.legacy_history' }))
    expect(await screen.findByText('Smart Assistant chat')).toBeInTheDocument()
  })

  it('opens the folder from the retired entry address', async () => {
    renderAssistant('/agents')
    expect(await screen.findByRole('button', { name: 'Old active' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'assistant_transition.legacy_history' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })
})
