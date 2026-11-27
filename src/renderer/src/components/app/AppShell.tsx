import './appShell.css'

import SearchPopup from '@renderer/components/Popups/SearchPopup'
import { isMac } from '@renderer/config/constant'
import { useAnnouncements } from '@renderer/context/AnnouncementProvider'
import { SIDEBAR_RESIZED, useSidebarShell } from '@renderer/context/SidebarSlotProvider'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useFullscreen } from '@renderer/hooks/useFullscreen'
import { useMCPServers } from '@renderer/hooks/useMCPServers'
import { modelGenerating } from '@renderer/hooks/useRuntime'
import { useShortcutDisplay } from '@renderer/hooks/useShortcuts'
import { runRouteTransition, uiRouteTransition } from '@renderer/services/UiThemePresetService'
import store from '@renderer/store'
import { ThemeMode } from '@renderer/types'
import { Popover, Tooltip } from 'antd'
import { Bell, Check, Monitor, Moon, Palette, PanelLeftClose, PanelLeftOpen, Search, Settings, Sun } from 'lucide-react'
import { type PropsWithChildren, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'

import WindowControls from '../WindowControls'
import UnifiedSidebar from './UnifiedSidebar'

function TitlebarActions() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { unreadCount } = useAnnouncements()
  const { preset, setPreset, settedTheme, setTheme } = useTheme()
  const routeTransition = useSyncExternalStore(uiRouteTransition.subscribe, uiRouteTransition.get)
  const searchShortcut = useShortcutDisplay('search_message')
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const searchLabel = t('chat.assistant.search.placeholder')
  const searchTooltip = searchShortcut ? `${searchLabel} (${searchShortcut})` : searchLabel
  const presetName =
    preset === 'codex' ? t('settings.theme.preset.codex.name') : t('settings.theme.preset.zen-paper.name')
  const appearanceTooltip = `${t('settings.theme.preset.title')} · ${presetName}`

  const handleTransitionNav = (to: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (store.getState().runtime.generating) {
      event.preventDefault()
      void modelGenerating().catch(() => {})
      return
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    runRouteTransition(pathname, to, () => navigate(to))
  }

  const appearanceContent = (
    <div className="zen-appearance-popover">
      <div className="zen-appearance-section">
        <div className="zen-appearance-label">{t('settings.theme.preset.title')}</div>
        <div className="zen-appearance-presets">
          {(
            [
              { key: 'codex', label: t('settings.theme.preset.codex.name'), swatch: 'codex' },
              { key: 'zen-paper', label: t('settings.theme.preset.zen-paper.name'), swatch: 'zen-paper' }
            ] as const
          ).map((item) => {
            const active = preset === item.key
            return (
              <button
                key={item.key}
                type="button"
                className="zen-appearance-preset-item"
                aria-pressed={active}
                onClick={() => setPreset(item.key)}>
                <span className={`zen-appearance-swatch ${item.swatch}`} aria-hidden="true" />
                <span className="zen-appearance-preset-name">{item.label}</span>
                {active && <Check size={13} className="zen-appearance-check" />}
              </button>
            )
          })}
        </div>
      </div>
      <div className="zen-appearance-divider" />
      <div className="zen-appearance-section">
        <div className="zen-appearance-label">{t('settings.theme.mode')}</div>
        <div className="zen-appearance-modes" role="group" aria-label={t('settings.theme.mode')}>
          {(
            [
              { mode: ThemeMode.light, label: t('settings.theme.light'), Icon: Sun },
              { mode: ThemeMode.dark, label: t('settings.theme.dark'), Icon: Moon },
              { mode: ThemeMode.system, label: t('settings.theme.system'), Icon: Monitor }
            ] as const
          ).map(({ mode, label, Icon }) => {
            const active = settedTheme === mode
            return (
              <button
                key={mode}
                type="button"
                className="zen-appearance-mode-btn"
                aria-pressed={active}
                onClick={() => setTheme(mode)}>
                <Icon size={13} />
                <span>{label}</span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="zen-appearance-divider" />
      <div className="zen-appearance-section">
        <div className="zen-appearance-label">{t('settings.theme.route_transition.title')}</div>
        <div
          className="zen-appearance-modes zen-appearance-modes-two"
          role="group"
          aria-label={t('settings.theme.route_transition.title')}>
          {(
            [
              { mode: 'crossfade', label: t('settings.theme.route_transition.crossfade') },
              { mode: 'instant', label: t('settings.theme.route_transition.instant') }
            ] as const
          ).map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              className="zen-appearance-mode-btn"
              aria-pressed={routeTransition === mode}
              onClick={() => uiRouteTransition.set(mode)}>
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )

  return (
    <div className="zen-titlebar-actions">
      <Tooltip title={searchTooltip} placement="bottom">
        <button
          type="button"
          className="zen-titlebar-icon"
          aria-label={searchLabel}
          onClick={() => void SearchPopup.show()}>
          <Search size={15} strokeWidth={1.75} />
        </button>
      </Tooltip>
      <Tooltip
        title={unreadCount > 0 ? `${t('announcements.title')} (${unreadCount})` : t('announcements.title')}
        placement="bottom">
        <NavLink
          to="/announcements"
          className="zen-titlebar-icon"
          aria-label={t('announcements.title')}
          onClick={handleTransitionNav('/announcements')}>
          <Bell size={15} strokeWidth={1.75} />
          {unreadCount > 0 && (
            <span className="zen-titlebar-unread tabular-nums">{unreadCount > 9 ? '9+' : unreadCount}</span>
          )}
        </NavLink>
      </Tooltip>
      <Popover
        open={appearanceOpen}
        onOpenChange={setAppearanceOpen}
        trigger={['click']}
        placement="bottomRight"
        arrow={false}
        styles={{ body: { padding: 10 } }}
        content={appearanceContent}>
        <Tooltip
          title={appearanceOpen ? null : appearanceTooltip}
          open={appearanceOpen ? false : undefined}
          placement="bottom">
          <button
            type="button"
            className="zen-titlebar-icon"
            aria-label={appearanceTooltip}
            aria-expanded={appearanceOpen}>
            <Palette size={15} strokeWidth={1.75} />
          </button>
        </Tooltip>
      </Popover>
      <Tooltip title={t('settings.title')} placement="bottom">
        <NavLink
          to="/settings"
          className="zen-titlebar-icon"
          aria-label={t('settings.title')}
          onClick={handleTransitionNav('/settings')}>
          <Settings size={15} strokeWidth={1.75} />
        </NavLink>
      </Tooltip>
    </div>
  )
}

export function AppShell({ children }: PropsWithChildren) {
  const shell = useSidebarShell()
  const isFullscreen = useFullscreen()
  const { pathname } = useLocation()
  const { activedMcpServers } = useMCPServers()
  const routeTransition = useSyncExternalStore(uiRouteTransition.subscribe, uiRouteTransition.get)
  const { t } = useTranslation()
  if (!shell) return null
  const { collapsed, toggleSidebar, setTitleSlot } = shell
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose
  const toggleLabel = collapsed ? t('navbar.show_sidebar') : t('navbar.hide_sidebar')
  const showMcpStatus =
    activedMcpServers.length > 0 &&
    (pathname === '/' || pathname === '/new-assistant' || pathname === '/internal-assistant')

  return (
    <div className="zen-app-shell" data-sidebar-collapsed={collapsed} data-route-transition={routeTransition}>
      <header className="zen-titlebar" data-traffic-lights={isMac && !isFullscreen}>
        <Tooltip title={toggleLabel} placement="bottom">
          <button
            type="button"
            className="zen-titlebar-toggle"
            aria-label={toggleLabel}
            aria-controls="app-sidebar"
            aria-expanded={!collapsed}
            onClick={toggleSidebar}>
            <ToggleIcon size={16} />
          </button>
        </Tooltip>
        <div className="zen-titlebar-slot" ref={setTitleSlot} />
        {showMcpStatus && (
          <Tooltip title={t('settings.mcp.title')} placement="bottom">
            <Link to="/settings/mcp" className="zen-titlebar-mcp" aria-label={t('settings.mcp.title')}>
              <span className="zen-status-dot" data-tone="normal" aria-hidden="true" />
              <span>{t('app_shell.mcp')}</span>
              <span className="tabular-nums">{activedMcpServers.length}</span>
            </Link>
          </Tooltip>
        )}
        <TitlebarActions />
        {!isMac && <span className="zen-titlebar-divider" aria-hidden="true" />}
        <WindowControls />
      </header>
      <div className="zen-app-workspace">
        <aside
          id="app-sidebar"
          aria-hidden={collapsed || undefined}
          inert={collapsed}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === 'width') {
              window.dispatchEvent(new Event(SIDEBAR_RESIZED))
            }
          }}>
          <UnifiedSidebar />
        </aside>
        <div className="zen-app-canvas">
          <div className="zen-route-view">{children}</div>
        </div>
      </div>
    </div>
  )
}
