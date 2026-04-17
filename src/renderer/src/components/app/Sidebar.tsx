import EmojiAvatar from '@renderer/components/Avatar/EmojiAvatar'
import { isMac } from '@renderer/config/constant'
import { UserAvatar } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import useAvatar from '@renderer/hooks/useAvatar'
import { useFullscreen } from '@renderer/hooks/useFullscreen'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import { useMinapps } from '@renderer/hooks/useMinapps'
import useNavBackgroundColor from '@renderer/hooks/useNavBackgroundColor'
import { modelGenerating, useRuntime } from '@renderer/hooks/useRuntime'
import { useSettings } from '@renderer/hooks/useSettings'
import { getSidebarIconLabel, getThemeModeLabel } from '@renderer/i18n/label'
import { ThemeMode } from '@renderer/types'
import { isEmoji } from '@renderer/utils'
import { Avatar, Tooltip } from 'antd'
import {
  Code,
  FileSearch,
  Folder,
  Languages,
  LayoutGrid,
  MessageSquare,
  Monitor,
  Moon,
  MousePointerClick,
  NotepadText,
  Palette,
  Settings,
  Sparkle,
  Sun
} from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import { OpenClawSidebarIcon } from '../Icons/SVGIcon'
import UserPopup from '../Popups/UserPopup'
import { SidebarOpenedMinappTabs, SidebarPinnedApps } from './PinnedMinapps'

interface SidebarMenuItemProps {
  active?: boolean
  label: string
  onClick: () => void
  theme: string
  tooltip?: string
  children: ReactNode
}

const SidebarMenuItem: FC<SidebarMenuItemProps> = ({ active = false, label, onClick, theme, tooltip, children }) => (
  <Tooltip title={tooltip || label} mouseEnterDelay={0.8} placement="right">
    <StyledLink onClick={onClick}>
      <MenuButton theme={theme} className={active ? 'active' : ''}>
        <MenuIconWrapper>{children}</MenuIconWrapper>
        <MenuLabel>{label}</MenuLabel>
      </MenuButton>
    </StyledLink>
  </Tooltip>
)

const Sidebar: FC = () => {
  const { hideMinappPopup } = useMinappPopup()
  const { minappShow } = useRuntime()
  const { sidebarIcons } = useSettings()
  const { pinned } = useMinapps()

  const { pathname } = useLocation()
  const navigate = useNavigate()

  const { theme, settedTheme, toggleTheme } = useTheme()
  const avatar = useAvatar()
  const { t } = useTranslation()

  const onEditUser = () => UserPopup.show()

  const backgroundColor = useNavBackgroundColor()

  const showPinnedApps = pinned.length > 0 && sidebarIcons.visible.includes('minapp')

  const to = async (path: string) => {
    await modelGenerating()
    navigate(path)
  }

  const isFullscreen = useFullscreen()

  return (
    <Container
      $isFullscreen={isFullscreen}
      id="app-sidebar"
      style={{ backgroundColor, zIndex: minappShow ? 10000 : 'initial' }}>
      {isEmoji(avatar) ? (
        <EmojiAvatar onClick={onEditUser} className="sidebar-avatar" size={31} fontSize={18}>
          {avatar}
        </EmojiAvatar>
      ) : (
        <AvatarImg src={avatar || UserAvatar} draggable={false} className="nodrag" onClick={onEditUser} />
      )}
      <MainMenusContainer>
        <Menus onClick={hideMinappPopup}>
          <MainMenus />
        </Menus>
        <SidebarOpenedMinappTabs />
        {showPinnedApps && (
          <AppsContainer>
            <Divider />
            <Menus>
              <SidebarPinnedApps />
            </Menus>
          </AppsContainer>
        )}
      </MainMenusContainer>
      <Menus>
        <SidebarMenuItem
          label={t('settings.theme.title')}
          onClick={toggleTheme}
          theme={theme}
          tooltip={t('settings.theme.title') + ': ' + getThemeModeLabel(settedTheme)}>
          {settedTheme === ThemeMode.dark ? (
            <Moon size={18} className="icon" />
          ) : settedTheme === ThemeMode.light ? (
            <Sun size={18} className="icon" />
          ) : (
            <Monitor size={18} className="icon" />
          )}
        </SidebarMenuItem>
        <SidebarMenuItem
          active={pathname.startsWith('/settings') && !minappShow}
          label={t('settings.title')}
          onClick={async () => {
            hideMinappPopup()
            await to('/settings/provider')
          }}
          theme={theme}>
          <Settings size={18} className="icon" />
        </SidebarMenuItem>
      </Menus>
    </Container>
  )
}

const MainMenus: FC = () => {
  const { hideMinappPopup } = useMinappPopup()
  const { pathname } = useLocation()
  const { sidebarIcons, defaultPaintingProvider } = useSettings()
  const { minappShow } = useRuntime()
  const navigate = useNavigate()
  const { theme } = useTheme()

  const isRoute = (path: string): string => (pathname === path && !minappShow ? 'active' : '')
  const isRoutes = (path: string): string => (pathname.startsWith(path) && path !== '/' && !minappShow ? 'active' : '')

  const iconMap = {
    assistants: <MessageSquare size={18} className="icon" />,
    agents: <MousePointerClick size={18} className="icon" />,
    store: <Sparkle size={18} className="icon" />,
    paintings: <Palette size={18} className="icon" />,
    translate: <Languages size={18} className="icon" />,
    minapp: <LayoutGrid size={18} className="icon" />,
    knowledge: <FileSearch size={18} className="icon" />,
    files: <Folder size={18} className="icon" />,
    notes: <NotepadText size={18} className="icon" />,
    code_tools: <Code size={18} className="icon" />,
    openclaw: <OpenClawSidebarIcon style={{ width: 18, height: 18 }} className="icon" />
  }

  const pathMap = {
    assistants: '/',
    agents: '/agents',
    store: '/store',
    paintings: `/paintings/${defaultPaintingProvider}`,
    translate: '/translate',
    minapp: '/apps',
    knowledge: '/knowledge',
    files: '/files',
    code_tools: '/code',
    notes: '/notes',
    openclaw: '/openclaw'
  }

  return sidebarIcons.visible.map((icon) => {
    const path = pathMap[icon]
    const isActive = path === '/' ? isRoute(path) : isRoutes(path)

    return (
      <SidebarMenuItem
        key={icon}
        active={!!isActive}
        label={getSidebarIconLabel(icon)}
        onClick={async () => {
          hideMinappPopup()
          await modelGenerating()
          navigate(path)
        }}
        theme={theme}>
        {iconMap[icon]}
      </SidebarMenuItem>
    )
  })
}

const Container = styled.div<{ $isFullscreen: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 8px 0;
  padding-bottom: 12px;
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  height: ${({ $isFullscreen }) => (isMac && !$isFullscreen ? 'calc(100vh - var(--navbar-height))' : '100vh')};
  -webkit-app-region: drag !important;
  margin-top: ${({ $isFullscreen }) => (isMac && !$isFullscreen ? 'env(titlebar-area-height)' : 0)};

  .sidebar-avatar {
    align-self: center;
    margin-bottom: ${isMac ? '12px' : '12px'};
    margin-top: ${isMac ? '0px' : '2px'};
    -webkit-app-region: none;
  }
`

const AvatarImg = styled(Avatar)`
  width: 31px;
  height: 31px;
  align-self: center;
  background-color: var(--color-background-soft);
  margin-bottom: ${isMac ? '12px' : '12px'};
  margin-top: ${isMac ? '0px' : '2px'};
  border: none;
  cursor: pointer;
`

const MainMenusContainer = styled.div`
  display: flex;
  flex: 1;
  width: 100%;
  flex-direction: column;
  overflow: hidden;
`

const Menus = styled.div`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  width: 100%;
  padding: 0 8px;
`

const MenuLabel = styled.span`
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--color-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const MenuIconWrapper = styled.div`
  width: 28px;
  height: 28px;
  min-width: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--color-background-soft);
  border: 0.5px solid var(--color-border);
`

const MenuButton = styled.div<{ theme: string }>`
  width: 100%;
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 10px;
  border-radius: 12px;
  box-sizing: border-box;
  -webkit-app-region: none;
  border: 0.5px solid transparent;

  .icon {
    color: var(--color-icon);
  }

  &:hover {
    background-color: ${({ theme }) => (theme === 'dark' ? 'var(--color-black)' : 'var(--color-white)')};
    opacity: 0.8;
    cursor: pointer;

    .icon {
      color: var(--color-icon-white);
    }

    ${/* sc-selector */ MenuLabel} {
      color: var(--color-text);
    }
  }

  &.active {
    background-color: ${({ theme }) => (theme === 'dark' ? 'var(--color-black)' : 'var(--color-white)')};
    border: 0.5px solid var(--color-border);

    .icon {
      color: var(--color-primary);
    }

    ${/* sc-selector */ MenuIconWrapper} {
      border-color: color-mix(in srgb, var(--color-primary) 18%, var(--color-border));
      background: color-mix(in srgb, var(--color-primary) 12%, var(--color-background-soft));
    }

    ${/* sc-selector */ MenuLabel} {
      color: var(--color-text);
      font-weight: 600;
    }
  }
`

const StyledLink = styled.div`
  text-decoration: none;
  -webkit-app-region: none;
  width: 100%;

  & * {
    user-select: none;
  }
`

const AppsContainer = styled.div`
  display: flex;
  flex: 1;
  width: 100%;
  flex-direction: column;
  align-items: stretch;
  overflow-y: auto;
  overflow-x: hidden;
  margin-bottom: 10px;
  -webkit-app-region: none;
  &::-webkit-scrollbar {
    display: none;
  }
`

const Divider = styled.div`
  width: 50%;
  margin: 8px 0;
  border-bottom: 0.5px solid var(--color-border);
`

export default Sidebar
