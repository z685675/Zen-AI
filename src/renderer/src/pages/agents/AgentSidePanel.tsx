import { AgentWorkspaceContext, useAgentWorkspace } from '@renderer/context/AgentWorkspaceProvider'
import { useSidebarShell } from '@renderer/context/SidebarSlotProvider'
import { useAgents } from '@renderer/hooks/agents/useAgents'
import type { LegacyConversation } from '@renderer/utils/legacyConversations'
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'

import GlobalSessions from './components/GlobalSessions'
import { LegacyConversationFolder } from './components/LegacyConversations'

interface AgentSidePanelProps {
  onSelectItem?: () => void
  showHistory?: boolean
  historySelection?: LegacyConversation
  showSessions?: boolean
}

export default function AgentSidePanel({
  onSelectItem,
  showHistory = false,
  historySelection,
  showSessions = true
}: AgentSidePanelProps) {
  const { agents } = useAgents()
  const navigate = useNavigate()
  const workspace = useAgentWorkspace()
  const shell = useSidebarShell()
  const agentsById = useMemo(() => Object.fromEntries((agents ?? []).map((agent) => [agent.id, agent])), [agents])

  const legacyFolder = workspace === 'opencode' && (
    <AgentWorkspaceContext value="legacy">
      <LegacyConversationFolder expanded={showHistory} selection={historySelection} serverAvailable={showSessions} />
    </AgentWorkspaceContext>
  )

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      style={shell ? undefined : { height: 'calc(100vh - var(--navbar-height))', width: 'var(--assistants-width)' }}>
      {showSessions ? (
        <div className="min-h-0 flex-1">
          <GlobalSessions
            agentsById={agentsById}
            legacyFolder={legacyFolder}
            isViewingLegacy={showHistory}
            onSelectItem={() => {
              if (showHistory) navigate('/new-assistant')
              onSelectItem?.()
            }}
          />
        </div>
      ) : (
        legacyFolder && <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pt-2.5">{legacyFolder}</div>
      )}
    </div>
  )
}
