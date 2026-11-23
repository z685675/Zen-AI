import { AgentWorkspaceContext, useAgentWorkspace } from '@renderer/context/AgentWorkspaceProvider'
import { useAgents } from '@renderer/hooks/agents/useAgents'
import { cn } from '@renderer/utils'
import { LEGACY_CONVERSATIONS_PATH, type LegacyConversation } from '@renderer/utils/legacyConversations'
import { Tooltip } from 'antd'
import { ChevronDown, ChevronRight, Folder, FolderOpen, PanelLeftClose } from 'lucide-react'
import type { PropsWithChildren } from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import Agents from './components/Agents'
import GlobalSessions from './components/GlobalSessions'
import { LegacyConversationList } from './components/LegacyConversations'

interface AgentSidePanelProps {
  onSelectItem?: () => void
  onCollapse?: () => void
  showHistory?: boolean
  historySelection?: LegacyConversation
}

const AgentSidePanel = ({ onSelectItem, onCollapse, showHistory = false, historySelection }: AgentSidePanelProps) => {
  const { agents } = useAgents()
  const { t } = useTranslation()
  const workspace = useAgentWorkspace()

  const agentsById = useMemo(() => {
    return Object.fromEntries((agents ?? []).map((agent) => [agent.id, agent]))
  }, [agents])

  return (
    <div
      className="flex flex-col overflow-hidden rounded-tl-[10px] rounded-bl-[10px] px-1.5 py-1.5"
      style={{
        width: 'var(--assistants-width)',
        height: 'calc(100vh - var(--navbar-height))',
        background: 'transparent'
      }}>
      <div className="flex shrink-0 items-center justify-end px-1 pb-1">
        <Tooltip title={t('navbar.hide_sidebar')} mouseEnterDelay={0.5}>
          <button
            type="button"
            aria-label={t('navbar.hide_sidebar')}
            onClick={onCollapse}
            className="flex h-7 w-7 items-center justify-center rounded-md border-0 bg-transparent p-0 text-[var(--color-text-2)] transition-colors hover:bg-[var(--color-background-mute)] hover:text-[var(--color-text)]">
            <PanelLeftClose size={16} />
          </button>
        </Tooltip>
      </div>
      <SectionShell className="max-h-[34%] min-h-[180px]" tone="agents">
        <Agents onSelectItem={showHistory ? () => window.navigate('/new-assistant') : onSelectItem} />
      </SectionShell>

      <div className="h-3 shrink-0" />

      <SectionShell className="min-h-0 flex-1" tone="sessions">
        {workspace === 'opencode' && (
          <button
            type="button"
            onClick={() => window.navigate(showHistory ? '/new-assistant' : LEGACY_CONVERSATIONS_PATH)}
            aria-expanded={showHistory}
            className="mx-2.5 mt-2 flex shrink-0 items-center gap-2 rounded-md border-0 bg-transparent px-2 py-2 font-medium text-(--color-text) text-xs hover:bg-(--color-list-item-hover)">
            {showHistory ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {showHistory ? <FolderOpen size={16} /> : <Folder size={16} />}
            {t('assistant_transition.legacy_history')}
          </button>
        )}
        {showHistory ? (
          <AgentWorkspaceContext value="legacy">
            <LegacyConversationList selection={historySelection} />
          </AgentWorkspaceContext>
        ) : (
          <div className="min-h-0 flex-1">
            <GlobalSessions agentsById={agentsById} onSelectItem={onSelectItem} />
          </div>
        )}
      </SectionShell>
    </div>
  )
}

const SectionShell = ({
  children,
  className,
  tone
}: PropsWithChildren<{ className?: string; tone: 'agents' | 'sessions' }>) => {
  return (
    <div
      className={cn('relative flex flex-col overflow-hidden rounded-[22px] border', className)}
      style={{
        borderColor: tone === 'agents' ? 'rgba(14, 116, 144, 0.10)' : 'rgba(15, 23, 42, 0.08)',
        background:
          tone === 'agents'
            ? 'linear-gradient(180deg, rgba(247,252,255,0.96) 0%, rgba(255,255,255,0.98) 100%)'
            : 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(249,250,251,0.96) 100%)',
        boxShadow:
          tone === 'agents'
            ? '0 10px 24px rgba(14, 116, 144, 0.05), inset 0 1px 0 rgba(255,255,255,0.7)'
            : '0 10px 24px rgba(15, 23, 42, 0.035), inset 0 1px 0 rgba(255,255,255,0.78)'
      }}>
      {tone === 'agents' && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-[linear-gradient(180deg,rgba(226,247,255,0.55),rgba(226,247,255,0))]" />
      )}
      {children}
    </div>
  )
}

export default AgentSidePanel
