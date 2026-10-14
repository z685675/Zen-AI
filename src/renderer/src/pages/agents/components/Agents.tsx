import DraggableVirtualList from '@renderer/components/DraggableList/virtual-list'
import { useAgentWorkspace } from '@renderer/context/AgentWorkspaceProvider'
import { useActiveAgent } from '@renderer/hooks/agents/useActiveAgent'
import { useAgents } from '@renderer/hooks/agents/useAgents'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { DEFAULT_FUSION_AGENT_ID } from '@shared/config/agents'
import { memo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import AgentItem from './AgentItem'

interface AgentsProps {
  onSelectItem?: () => void
}

const Agents = ({ onSelectItem }: AgentsProps) => {
  const { t } = useTranslation()
  const workspace = useAgentWorkspace()
  const { agents, deleteAgent, isLoading, error, reorderAgents } = useAgents()
  const { chat } = useRuntime()
  const { activeAgentId } = chat
  const { setActiveAgentId } = useActiveAgent()

  const handleAgentPress = useCallback(
    (agentId: string) => {
      void setActiveAgentId(agentId)
      onSelectItem?.()
    },
    [setActiveAgentId, onSelectItem]
  )

  if (isLoading) {
    return <div className="p-5 text-center text-(--color-text-secondary) text-[13px]">{t('common.loading')}</div>
  }

  if (error) {
    return <div className="p-5 text-center text-(--color-error) text-[13px]">{error.message}</div>
  }

  const hasNonOfficialAgent =
    workspace !== 'opencode' && (agents?.some((agent) => agent.id !== DEFAULT_FUSION_AGENT_ID) ?? false)
  const sidebarTitle = (
    <span className="min-w-0">
      <span style={workspace === 'opencode' ? undefined : { color: 'var(--color-deprecated-assistant)' }}>
        {t(workspace === 'opencode' ? 'new_assistant.title' : 'agent.sidebar_title')}
      </span>
      {hasNonOfficialAgent && (
        <span className="ml-1 font-normal text-(--color-text-secondary)">（建议删除其他非官方助手）</span>
      )}
    </span>
  )

  return (
    <div className="flex h-full flex-col">
      <DraggableVirtualList
        className="agents-tab flex min-h-0 flex-1 flex-col"
        itemStyle={{ marginBottom: 8 }}
        list={agents ?? []}
        estimateSize={() => 9 * 4}
        scrollerStyle={{ overflowX: 'hidden', padding: '12px 10px' }}
        onUpdate={reorderAgents}
        itemKey={(index) => (agents ?? [])[index]?.id ?? index}
        header={
          <div className="-mt-0.5 mb-1.5">
            <div className="px-2 py-1 font-medium text-(--color-text) text-xs">{sidebarTitle}</div>
          </div>
        }>
        {(agent) => (
          <AgentItem
            agent={agent}
            isActive={agent.id === activeAgentId}
            onDelete={() => deleteAgent(agent.id)}
            onPress={() => handleAgentPress(agent.id)}
          />
        )}
      </DraggableVirtualList>
    </div>
  )
}

export default memo(Agents)
