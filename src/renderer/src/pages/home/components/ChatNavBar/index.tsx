import { NavbarHeader } from '@renderer/components/app/Navbar'
import SearchPopup from '@renderer/components/Popups/SearchPopup'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import type { Assistant, Topic } from '@renderer/types'
import { getTopicConversationModel } from '@renderer/utils/conversationModel'
import type { FC } from 'react'
import { useMemo } from 'react'

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
  const { assistant: storedAssistant } = useAssistant(activeAssistant.id)
  const assistant = useMemo(
    () => ({ ...storedAssistant, model: getTopicConversationModel(activeTopic, storedAssistant) }),
    [activeTopic, storedAssistant]
  )

  useShortcut('search_message', () => {
    void SearchPopup.show()
  })

  return (
    <NavbarHeader className="home-navbar" style={{ height: 'var(--navbar-height)' }}>
      <div className="flex h-full min-w-0 flex-1 shrink items-center overflow-auto">
        <ChatNavbarContent
          assistant={assistant}
          assistants={assistants}
          activeTopic={activeTopic}
          setActiveAssistant={setActiveAssistant}
          setActiveTopic={setActiveTopic}
        />
      </div>
    </NavbarHeader>
  )
}

export default HeaderNavbar
