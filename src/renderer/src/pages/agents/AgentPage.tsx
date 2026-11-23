import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import ModelSetupGuide from '@renderer/components/ModelSetupGuide'
import { AgentWorkspaceContext, useAgentWorkspace } from '@renderer/context/AgentWorkspaceProvider'
import { useActiveAgent } from '@renderer/hooks/agents/useActiveAgent'
import { useAgents } from '@renderer/hooks/agents/useAgents'
import { useRestoreAgentSession } from '@renderer/hooks/agents/useRestoreAgentSession'
import { useApiServer } from '@renderer/hooks/useApiServer'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useNavbarPosition } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants } from '@renderer/hooks/useStore'
import { useAppSelector } from '@renderer/store'
import { cn } from '@renderer/utils'
import { readLegacyConversation } from '@renderer/utils/legacyConversations'
import { getAvailableChatModels } from '@renderer/utils/modelAvailability'
import { getPreferredAgentId } from '@shared/config/agents'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, SECOND_MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { AnimatePresence, motion } from 'motion/react'
import type { PropsWithChildren } from 'react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import AgentChat from './AgentChat'
import AgentNavbar from './AgentNavbar'
import AgentSidePanel from './AgentSidePanel'
import { LegacyConversationView } from './components/LegacyConversations'
import { AgentEmpty, AgentServerDisabled, AgentServerStopped } from './components/status'

const AgentPage = () => {
  const workspace = useAgentWorkspace()
  const [query] = useSearchParams()
  const showHistory = workspace === 'opencode' && query.get('history') === 'legacy'
  const historySelection = showHistory ? readLegacyConversation(query) : undefined
  const { isLeftNavbar } = useNavbarPosition()
  const { showAssistants, toggleShowAssistants } = useShowAssistants()
  const { chat } = useRuntime()
  const { activeAgentId } = chat
  const { agents } = useAgents()
  const { setActiveAgentId } = useActiveAgent()
  const { apiServerConfig, apiServerRunning, apiServerLoading } = useApiServer()
  const { t } = useTranslation()
  const providers = useAppSelector((state) => state.llm.providers)
  const hasAvailableModels = getAvailableChatModels(providers).length > 0
  useRestoreAgentSession(agents, apiServerRunning && !showHistory)

  useShortcut('toggle_show_assistants', () => {
    toggleShowAssistants()
  })

  // Prefer the built-in fusion agent when available, otherwise fall back to the first agent.
  useEffect(() => {
    if (!agents || agents.length === 0) {
      return
    }

    const hasActiveAgent = activeAgentId ? agents.some((agent) => agent.id === activeAgentId) : false
    const preferredAgentId = getPreferredAgentId(agents)

    if ((!activeAgentId || !hasActiveAgent) && preferredAgentId) {
      void setActiveAgentId(preferredAgentId)
    }
  }, [activeAgentId, agents, setActiveAgentId])

  useEffect(() => {
    const canMinimize = !showAssistants
    void window.api.window.setMinimumSize(canMinimize ? SECOND_MIN_WINDOW_WIDTH : MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
    return () => {
      void window.api.window.resetMinimumSize()
    }
  }, [showAssistants])

  if (!apiServerConfig.enabled) {
    return (
      <Container>
        <Navbar>
          <NavbarCenter style={{ borderRight: 'none' }}>{t('common.agent_one')}</NavbarCenter>
        </Navbar>
        <AgentServerDisabled />
      </Container>
    )
  }

  if (!apiServerLoading && !apiServerRunning) {
    return (
      <Container>
        <Navbar>
          <NavbarCenter style={{ borderRight: 'none' }}>{t('common.agent_one')}</NavbarCenter>
        </Navbar>
        <AgentServerStopped />
      </Container>
    )
  }

  if (workspace === 'dsh' && !hasAvailableModels) {
    return (
      <Container>
        <Navbar>
          <NavbarCenter style={{ borderRight: 'none' }}>{t('common.agent_one')}</NavbarCenter>
        </Navbar>
        <ModelSetupGuide />
      </Container>
    )
  }

  if (workspace !== 'opencode' && agents && agents.length === 0) {
    return (
      <Container>
        <Navbar>
          <NavbarCenter style={{ borderRight: 'none' }}>{t('common.agent_one')}</NavbarCenter>
        </Navbar>
        <AgentEmpty />
      </Container>
    )
  }

  return (
    <Container>
      <AgentWorkspaceContext value={showHistory ? 'legacy' : workspace}>
        <AgentNavbar showSidebarControl={showHistory || !hasAvailableModels || !agents?.length} />
      </AgentWorkspaceContext>
      <div
        id={isLeftNavbar ? 'content-container' : undefined}
        className="flex min-w-0 flex-1 shrink flex-row overflow-hidden">
        <AnimatePresence initial={false}>
          {showAssistants && (
            <ErrorBoundary>
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 'var(--assistants-width)', opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
                style={{ overflow: 'hidden' }}>
                <AgentSidePanel
                  onCollapse={() => toggleShowAssistants()}
                  showHistory={showHistory}
                  historySelection={historySelection}
                />
              </motion.div>
            </ErrorBoundary>
          )}
        </AnimatePresence>
        <ErrorBoundary>
          {showHistory ? (
            historySelection ? (
              <AgentWorkspaceContext value="legacy">
                <LegacyConversationView
                  key={`${historySelection.agentId}:${historySelection.sessionId}`}
                  {...historySelection}
                />
              </AgentWorkspaceContext>
            ) : (
              <p className="m-auto text-(--color-text-secondary) text-sm">
                {t(query.has('session') ? 'agent.session.get.error.failed' : 'assistant_transition.select_history')}
              </p>
            )
          ) : workspace === 'opencode' && !hasAvailableModels ? (
            <div className="min-w-0 flex-1 overflow-y-auto">
              <ModelSetupGuide />
            </div>
          ) : agents?.length === 0 ? (
            <AgentEmpty />
          ) : (
            activeAgentId && agents?.some((agent) => agent.id === activeAgentId) && <AgentChat key={workspace} />
          )}
        </ErrorBoundary>
      </div>
    </Container>
  )
}

const Container = ({ children, className }: PropsWithChildren<{ className?: string }>) => {
  return (
    <div id="agent-page" className={cn('flex flex-1 flex-col overflow-hidden', className)}>
      {children}
    </div>
  )
}

export default AgentPage
