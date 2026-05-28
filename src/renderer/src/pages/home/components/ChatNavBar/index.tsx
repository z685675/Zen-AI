import { NavbarHeader } from '@renderer/components/app/Navbar'
import SearchPopup from '@renderer/components/Popups/SearchPopup'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import type { Assistant, Topic } from '@renderer/types'
import type { FC } from 'react'

import ChatNavbarContent from './ChatNavbarContent'

interface Props {
  assistants: Assistant[]
  activeAssistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  setActiveAssistant: (assistant: Assistant) => void
  position: 'left' | 'right'
}

const HeaderNavbar: FC<Props> = ({ assistants, activeAssistant, setActiveAssistant, activeTopic, setActiveTopic }) => {
  const { assistant } = useAssistant(activeAssistant.id)
  void setActiveAssistant
  void activeTopic
  void setActiveTopic

  useShortcut('search_message', () => {
    void SearchPopup.show()
  })

  return (
    <NavbarHeader className="home-navbar" style={{ height: 'var(--navbar-height)' }}>
      <div className="flex h-full min-w-0 flex-1 shrink items-center overflow-auto">
        <ChatNavbarContent assistant={assistant} assistants={assistants} setActiveAssistant={setActiveAssistant} />
      </div>
    </NavbarHeader>
  )
}

export default HeaderNavbar
