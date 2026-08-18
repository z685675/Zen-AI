import { NavbarHeader } from '@renderer/components/app/Navbar'
import NavbarIcon from '@renderer/components/NavbarIcon'
import SearchPopup from '@renderer/components/Popups/SearchPopup'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import type { Assistant, Topic } from '@renderer/types'
import { getTopicConversationModel } from '@renderer/utils/conversationModel'
import { Tooltip } from 'antd'
import { PanelLeftOpen } from 'lucide-react'
import type { FC } from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import ChatNavbarContent from './ChatNavbarContent'

interface Props {
  assistants: Assistant[]
  activeAssistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  setActiveAssistant: (assistant: Assistant) => void
  position: 'left' | 'right'
  showConversationHistoryToggle?: boolean
  onShowConversationHistory?: () => void
}

const HeaderNavbar: FC<Props> = ({
  assistants,
  activeAssistant,
  setActiveAssistant,
  activeTopic,
  setActiveTopic,
  showConversationHistoryToggle,
  onShowConversationHistory
}) => {
  const { assistant: storedAssistant } = useAssistant(activeAssistant.id)
  const { t } = useTranslation()
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
        {showConversationHistoryToggle && (
          <Tooltip title={t('navbar.show_sidebar')} mouseEnterDelay={0.5}>
            <NavbarIcon onClick={onShowConversationHistory}>
              <PanelLeftOpen size={17} />
            </NavbarIcon>
          </Tooltip>
        )}
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
