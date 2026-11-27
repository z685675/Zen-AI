import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import NavbarIcon from '@renderer/components/NavbarIcon'
import AgentSearchPopup from '@renderer/components/Popups/AgentSearchPopup'
import { useAgentWorkspace } from '@renderer/context/AgentWorkspaceProvider'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { Tooltip } from 'antd'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export default function AgentNavbar() {
  const workspace = useAgentWorkspace()
  const { t } = useTranslation()
  const title = workspace === 'legacy' ? t('assistant_transition.legacy_history') : t('common.agent_one')
  const searchLabel = t('agent.session.search.placeholder')
  const search = () => {
    void AgentSearchPopup.show(workspace)
  }
  useShortcut('search_message', search)

  return (
    <Navbar>
      <NavbarCenter>{title}</NavbarCenter>
      <Tooltip title={searchLabel}>
        <NavbarIcon onClick={search} aria-label={searchLabel}>
          <Search size={16} />
        </NavbarIcon>
      </Tooltip>
    </Navbar>
  )
}
