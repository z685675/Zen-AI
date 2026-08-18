import { NavbarHeader } from '@renderer/components/app/Navbar'
import NavbarIcon from '@renderer/components/NavbarIcon'
import AgentSearchPopup from '@renderer/components/Popups/AgentSearchPopup'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants } from '@renderer/hooks/useStore'
import type { AgentEntity } from '@renderer/types'
import { cn } from '@renderer/utils'
import { Tooltip } from 'antd'
import { PanelLeftOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import AgentContent from './AgentContent'

interface Props {
  activeAgent: AgentEntity
  className?: string
}

const AgentChatNavbar = ({ activeAgent, className }: Props) => {
  const { showAssistants, setShowAssistants } = useShowAssistants()
  const { t } = useTranslation()

  useShortcut('search_message', () => {
    void AgentSearchPopup.show()
  })

  return (
    <NavbarHeader className={cn('agent-navbar h-(--navbar-height)', className)}>
      <div className="flex h-full min-w-0 flex-1 shrink items-center overflow-auto">
        {!showAssistants && (
          <Tooltip title={t('navbar.show_sidebar')} mouseEnterDelay={0.5}>
            <NavbarIcon aria-label={t('navbar.show_sidebar')} onClick={() => setShowAssistants(true)}>
              <PanelLeftOpen size={17} />
            </NavbarIcon>
          </Tooltip>
        )}
        <AgentContent activeAgent={activeAgent} />
      </div>
    </NavbarHeader>
  )
}

export default AgentChatNavbar
