import { NavbarHeader } from '@renderer/components/app/Navbar'
import NavbarIcon from '@renderer/components/NavbarIcon'
import AgentSearchPopup from '@renderer/components/Popups/AgentSearchPopup'
import { useAgentWorkspace } from '@renderer/context/AgentWorkspaceProvider'
import { useActiveAgent } from '@renderer/hooks/agents/useActiveAgent'
import { useAgents } from '@renderer/hooks/agents/useAgents'
import { useEnableDeveloperMode } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import type { AgentEntity } from '@renderer/types'
import { Select, Tooltip } from 'antd'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import AgentContent from './AgentContent'

interface Props {
  activeAgent: AgentEntity
}

export default function AgentChatNavbar({ activeAgent }: Props) {
  const workspace = useAgentWorkspace()
  const { t } = useTranslation()
  const { enableDeveloperMode } = useEnableDeveloperMode()
  const { agents } = useAgents()
  const { setActiveAgentId } = useActiveAgent()
  const searchLabel = t('agent.session.search.placeholder')
  const search = () => {
    void AgentSearchPopup.show(workspace)
  }
  useShortcut('search_message', search)

  return (
    <NavbarHeader className="min-w-0 gap-2">
      {enableDeveloperMode && agents && agents.length > 1 && (
        <Select
          size="small"
          aria-label={t('common.agent_one')}
          value={activeAgent.id}
          options={agents.map(({ id, name }) => ({ value: id, label: name }))}
          onChange={(id) => {
            void setActiveAgentId(id)
          }}
        />
      )}
      <AgentContent />
      <Tooltip title={searchLabel}>
        <NavbarIcon onClick={search} aria-label={searchLabel}>
          <Search size={16} />
        </NavbarIcon>
      </Tooltip>
    </NavbarHeader>
  )
}
