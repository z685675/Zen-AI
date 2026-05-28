import { Navbar, NavbarCenter, NavbarRight } from '@renderer/components/app/Navbar'
import { HStack } from '@renderer/components/Layout'
import SearchPopup from '@renderer/components/Popups/SearchPopup'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import type { Assistant, Topic } from '@renderer/types'
import { Tooltip } from 'antd'
import { t } from 'i18next'
import { Search } from 'lucide-react'
import type { FC } from 'react'
import styled from 'styled-components'

import NavbarIcon from '../../components/NavbarIcon'

interface Props {
  activeAssistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  setActiveAssistant: (assistant: Assistant) => void
  position: 'left' | 'right'
}

const HeaderNavbar: FC<Props> = () => {
  useShortcut('search_message', () => {
    void SearchPopup.show()
  })

  return (
    <Navbar className="home-navbar" style={{ backgroundColor: '#f7f8fa' }}>
      <NavbarCenter></NavbarCenter>
      <NavbarRight
        style={{
          justifyContent: 'flex-end',
          flex: 1,
          position: 'relative',
          paddingRight: '15px'
        }}
        className="home-navbar-right">
        <HStack alignItems="center" gap={6}>
          <Tooltip title={t('chat.assistant.search.placeholder')} mouseEnterDelay={0.8}>
            <NarrowIcon onClick={() => SearchPopup.show()}>
              <Search size={18} />
            </NarrowIcon>
          </Tooltip>
        </HStack>
      </NavbarRight>
    </Navbar>
  )
}

const NarrowIcon = styled(NavbarIcon)`
  @media (max-width: 1000px) {
    display: none;
  }
`

export default HeaderNavbar
