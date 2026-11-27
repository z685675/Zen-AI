import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import ModelSetupGuide from '@renderer/components/ModelSetupGuide'
import { AgentWorkspaceContext, useAgentWorkspace } from '@renderer/context/AgentWorkspaceProvider'
import { SidebarBodySlot } from '@renderer/context/SidebarSlotProvider'
import { useActiveAgent } from '@renderer/hooks/agents/useActiveAgent'
import { useAgents } from '@renderer/hooks/agents/useAgents'
import { useRestoreAgentSession } from '@renderer/hooks/agents/useRestoreAgentSession'
import { useApiServer } from '@renderer/hooks/useApiServer'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useAppSelector } from '@renderer/store'
import { readLegacyConversation } from '@renderer/utils/legacyConversations'
import { getAvailableChatModels } from '@renderer/utils/modelAvailability'
import { getPreferredAgentId } from '@shared/config/agents'
import { type ReactNode, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import AgentChat from './AgentChat'
import AgentNavbar from './AgentNavbar'
import AgentSidePanel from './AgentSidePanel'
import { LegacyConversationView } from './components/LegacyConversations'
import { AgentEmpty, AgentServerDisabled, AgentServerStopped } from './components/status'

export default function AgentPage() {
  const workspace = useAgentWorkspace()
  const [query] = useSearchParams()
  const showHistory = workspace === 'opencode' && query.get('history') === 'legacy'
  const historySelection = showHistory ? readLegacyConversation(query) : undefined
  const {
    chat: { activeAgentId }
  } = useRuntime()
  const { agents } = useAgents()
  const { setActiveAgentId } = useActiveAgent()
  const { apiServerConfig, apiServerRunning, apiServerLoading } = useApiServer()
  const { t } = useTranslation()
  const providers = useAppSelector((state) => state.llm.providers)
  const hasAvailableModels = getAvailableChatModels(providers).length > 0
  useRestoreAgentSession(agents, apiServerRunning && !showHistory)

  useEffect(() => {
    if (!agents?.length) return
    const hasActiveAgent = agents.some((agent) => agent.id === activeAgentId)
    const preferredAgentId = getPreferredAgentId(agents)
    if (!hasActiveAgent && preferredAgentId) void setActiveAgentId(preferredAgentId)
  }, [activeAgentId, agents, setActiveAgentId])

  let content: ReactNode
  const showChat =
    !showHistory &&
    apiServerConfig.enabled &&
    (apiServerRunning || apiServerLoading) &&
    hasAvailableModels &&
    agents?.some((agent) => agent.id === activeAgentId)
  if (showHistory) {
    content = historySelection ? (
      <AgentWorkspaceContext value="legacy">
        <LegacyConversationView {...historySelection} />
      </AgentWorkspaceContext>
    ) : (
      <p className="zen-view-enter m-auto text-(--color-text-secondary) text-sm">
        {t(query.has('session') ? 'agent.session.get.error.failed' : 'assistant_transition.select_history')}
      </p>
    )
  } else if (!apiServerConfig.enabled) {
    content = <AgentServerDisabled />
  } else if (!apiServerLoading && !apiServerRunning) {
    content = <AgentServerStopped />
  } else if (!hasAvailableModels) {
    content = (
      <div className="min-w-0 flex-1 overflow-y-auto">
        <ModelSetupGuide />
      </div>
    )
  } else if (agents?.length === 0) {
    content = <AgentEmpty />
  } else if (showChat) {
    content = <AgentChat key={workspace} />
  }

  return (
    <div id="agent-page" className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <SidebarBodySlot>
        <ErrorBoundary>
          <AgentSidePanel
            showHistory={showHistory}
            historySelection={historySelection}
            showSessions={apiServerConfig.enabled && (apiServerRunning || apiServerLoading)}
          />
        </ErrorBoundary>
      </SidebarBodySlot>
      {!showChat && (
        <AgentWorkspaceContext value={showHistory ? 'legacy' : workspace}>
          <AgentNavbar />
        </AgentWorkspaceContext>
      )}
      <div
        id="content-container"
        key={showHistory ? 'legacy' : 'live'}
        className="zen-view-enter flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <ErrorBoundary>{content}</ErrorBoundary>
      </div>
    </div>
  )
}
