import { Navbar, NavbarCenter, NavbarRight } from '@renderer/components/app/Navbar'
import { HStack } from '@renderer/components/Layout'
import NavbarIcon from '@renderer/components/NavbarIcon'
import AgentSearchPopup from '@renderer/components/Popups/AgentSearchPopup'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { Tooltip } from 'antd'
import { t } from 'i18next'
import { Search } from 'lucide-react'

const AgentNavbar = () => {
  useShortcut('search_message', () => {
    void AgentSearchPopup.show()
  })

  return (
    <Navbar className="agent-navbar">
      <NavbarCenter></NavbarCenter>
      <NavbarRight
        style={{
          justifyContent: 'flex-end',
          flex: 'none',
          position: 'relative',
          paddingRight: '15px',
          minWidth: 'auto'
        }}
        className="agent-navbar-right">
        <HStack alignItems="center" gap={6}>
          <Tooltip title={t('agent.session.search.placeholder')} mouseEnterDelay={0.8}>
            <NavbarIcon className="max-[1000px]:hidden" onClick={() => AgentSearchPopup.show()}>
              <Search size={18} />
            </NavbarIcon>
          </Tooltip>
        </HStack>
      </NavbarRight>
    </Navbar>
  )
}

export default AgentNavbar
