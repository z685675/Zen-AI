import { NavbarHeader } from '@renderer/components/app/Navbar'
import AgentSearchPopup from '@renderer/components/Popups/AgentSearchPopup'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import type { AgentEntity } from '@renderer/types'
import { cn } from '@renderer/utils'

import AgentContent from './AgentContent'

interface Props {
  activeAgent: AgentEntity
  className?: string
}

const AgentChatNavbar = ({ activeAgent, className }: Props) => {
  useShortcut('search_message', () => {
    void AgentSearchPopup.show()
  })

  return (
    <NavbarHeader className={cn('agent-navbar h-(--navbar-height)', className)}>
      <div className="flex h-full min-w-0 flex-1 shrink items-center overflow-auto">
        <AgentContent activeAgent={activeAgent} />
      </div>
    </NavbarHeader>
  )
}

export default AgentChatNavbar
