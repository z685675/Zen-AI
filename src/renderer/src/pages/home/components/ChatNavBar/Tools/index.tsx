import { HStack } from '@renderer/components/Layout'
import NavbarIcon from '@renderer/components/NavbarIcon'
import SearchPopup from '@renderer/components/Popups/SearchPopup'
import { useNavbarPosition } from '@renderer/hooks/useSettings'
import type { Assistant } from '@renderer/types'
import { Tooltip } from 'antd'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import SettingsButton from './SettingsButton'

interface ToolsProps {
  assistant?: Assistant
}

const Tools = ({ assistant }: ToolsProps) => {
  const { t } = useTranslation()
  const { isTopNavbar } = useNavbarPosition()

  return (
    <HStack alignItems="center" gap={8}>
      <SettingsButton assistant={assistant} />
      {isTopNavbar && (
        <Tooltip title={t('chat.assistant.search.placeholder')} mouseEnterDelay={0.8}>
          <NavbarIcon onClick={() => SearchPopup.show()}>
            <Search size={18} />
          </NavbarIcon>
        </Tooltip>
      )}
    </HStack>
  )
}

export default Tools
