import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { useActiveAgent } from '@renderer/hooks/agents/useActiveAgent'
import { useAgents } from '@renderer/hooks/agents/useAgents'
import { useApiServer } from '@renderer/hooks/useApiServer'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useNavbarPosition } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants } from '@renderer/hooks/useStore'
import { cn } from '@renderer/utils'
import { getPreferredAgentId } from '@shared/config/agents'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, SECOND_MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { AnimatePresence, motion } from 'motion/react'
import type { PropsWithChildren } from 'react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import AgentChat from './AgentChat'
import AgentNavbar from './AgentNavbar'
import AgentSidePanel from './AgentSidePanel'
import { AgentEmpty, AgentServerDisabled, AgentServerStopped } from './components/status'

const AgentPage = () => {
  const { isLeftNavbar } = useNavbarPosition()
  const { showAssistants, toggleShowAssistants } = useShowAssistants()
  const { chat } = useRuntime()
  const { activeAgentId } = chat
  const { agents } = useAgents()
  const { setActiveAgentId } = useActiveAgent()
  const { apiServerConfig, apiServerRunning, apiServerLoading } = useApiServer()
  const { t } = useTranslation()

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

  if (agents && agents.length === 0) {
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
      <AgentNavbar />
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
                <AgentSidePanel />
              </motion.div>
            </ErrorBoundary>
          )}
        </AnimatePresence>
        <ErrorBoundary>
          <AgentChat />
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
