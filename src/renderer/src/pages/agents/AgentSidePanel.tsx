import { useAgents } from '@renderer/hooks/agents/useAgents'
import { cn } from '@renderer/utils'
import type { PropsWithChildren } from 'react'
import { useMemo } from 'react'

import Agents from './components/Agents'
import GlobalSessions from './components/GlobalSessions'

interface AgentSidePanelProps {
  onSelectItem?: () => void
}

const AgentSidePanel = ({ onSelectItem }: AgentSidePanelProps) => {
  const { agents } = useAgents()

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
      <SectionShell className="max-h-[34%] min-h-[180px]" tone="agents">
        <Agents onSelectItem={onSelectItem} />
      </SectionShell>

      <div className="h-3 shrink-0" />

      <SectionShell className="min-h-0 flex-1" tone="sessions">
        <GlobalSessions agentsById={agentsById} onSelectItem={onSelectItem} />
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
