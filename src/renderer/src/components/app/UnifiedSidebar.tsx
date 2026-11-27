import { uiSidebarPlacements, UNIFIED_SIDEBAR_ENTRIES, type UnifiedSidebarEntry } from '@renderer/config/unifiedSidebar'
import { AgentWorkspaceContext } from '@renderer/context/AgentWorkspaceProvider'
import { useSidebarShell } from '@renderer/context/SidebarSlotProvider'
import { useAllSessions } from '@renderer/hooks/agents/useAllSessions'
import { modelGenerating } from '@renderer/hooks/useRuntime'
import { useEnableDeveloperMode } from '@renderer/hooks/useSettings'
import { useDshPreviewStatus } from '@renderer/services/DshPreviewService'
import { runRouteTransition } from '@renderer/services/UiThemePresetService'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import { selectAllTopics } from '@renderer/store/assistants'
import { setActiveAgentId, setActiveSessionIdAction } from '@renderer/store/runtime'
import { isAgentSessionTopicId } from '@renderer/utils/agentSession'
import { isUnnamedAgentSessionName } from '@renderer/utils/agentSessionTitle'
import { ChevronRight, FlaskConical } from 'lucide-react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, type NavLinkProps, useLocation, useNavigate } from 'react-router-dom'

function SidebarLink(props: NavLinkProps) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  return (
    <NavLink
      {...props}
      onClick={(event) => {
        if (store.getState().runtime.generating) {
          event.preventDefault()
          void modelGenerating().catch(() => {})
          return
        }
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
        if (typeof props.to === 'string') {
          event.preventDefault()
          runRouteTransition(pathname, props.to, () => navigate(props.to as string))
        }
      }}
    />
  )
}

function RecentItems() {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const { sessions } = useAllSessions({}, 5)
  const topics = useAppSelector(selectAllTopics)
  const assistants = useAppSelector((state) => state.assistants.assistants)
  const unnamed = t('common.unnamed')
  const items = [
    ...sessions
      .filter((session) => !isUnnamedAgentSessionName(session.name, unnamed))
      .map((session) => ({
        id: session.id,
        label: session.name,
        updated: new Date(session.updated_at || session.created_at).getTime(),
        select: () => {
          dispatch(setActiveAgentId(session.agent_id))
          dispatch(setActiveSessionIdAction({ agentId: session.agent_id, sessionId: session.id }))
          navigate('/new-assistant')
        }
      })),
    ...topics
      .filter((topic) => !isUnnamedAgentSessionName(topic.name, unnamed))
      .map((topic) => ({
        id: topic.id,
        label: topic.name,
        updated: new Date(topic.updatedAt || topic.createdAt).getTime(),
        select: () =>
          navigate('/', { state: { topic, assistant: assistants.find(({ id }) => id === topic.assistantId) } })
      }))
  ]
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 5)

  return (
    <section className="zen-sidebar-recent" aria-label={t('app_shell.recent')}>
      <h2>{t('app_shell.recent')}</h2>
      {items.length === 0 && <p>{t('history.no_history')}</p>}
      {items.map(({ id, label, select }) => (
        <button key={id} type="button" className="zen-sidebar-row" title={label} onClick={select}>
          {label}
        </button>
      ))}
    </section>
  )
}

export default function UnifiedSidebar() {
  const shell = useSidebarShell()
  const { pathname } = useLocation()
  const { t } = useTranslation()
  const { enableDeveloperMode } = useEnableDeveloperMode()
  const internal = useDshPreviewStatus()
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const placements = useSyncExternalStore(uiSidebarPlacements.subscribe, uiSidebarPlacements.get)
  const availableEntries = useMemo(
    () => UNIFIED_SIDEBAR_ENTRIES.filter((entry) => !entry.developerOnly || enableDeveloperMode),
    [enableDeveloperMode]
  )
  const primaryEntries = useMemo(
    () => availableEntries.filter((entry) => placements[entry.id] === 'primary'),
    [availableEntries, placements]
  )
  const moreEntries = useMemo(
    () => availableEntries.filter((entry) => placements[entry.id] === 'more'),
    [availableEntries, placements]
  )
  const hasMoreDrawerItems = moreEntries.length > 0 || Boolean(internal?.unlocked)
  const hasSidebarContent = ['/', '/new-assistant', '/notes', '/internal-assistant'].includes(pathname)
  const hideRecentItems =
    hasSidebarContent ||
    pathname === '/paintings' ||
    pathname.startsWith('/paintings/') ||
    pathname === '/translate' ||
    pathname.startsWith('/translate/') ||
    pathname === '/files' ||
    pathname.startsWith('/files/')
  const running = useAppSelector(
    (state) =>
      Object.entries(state.messages.loadingByTopic).filter(
        ([topicId, loading]) => loading && isAgentSessionTopicId(topicId)
      ).length
  )
  if (!shell) return null

  const renderNavEntry = (entry: UnifiedSidebarEntry) => {
    const Icon = entry.icon
    const iconSize = entry.id === 'new_assistant' || entry.id === 'paintings' ? 16 : 15
    return (
      <SidebarLink key={entry.id} className="zen-sidebar-row" to={entry.path} end={entry.end}>
        <Icon size={iconSize} /> <span>{t(entry.labelKey)}</span>
        {entry.id === 'new_assistant' && running > 0 && (
          <span className="zen-sidebar-count tabular-nums">{running}</span>
        )}
      </SidebarLink>
    )
  }

  return (
    <div className="zen-sidebar">
      <nav className="zen-sidebar-nav" aria-label={t('app_shell.navigation')}>
        {primaryEntries.map(renderNavEntry)}
        {hasMoreDrawerItems && (
          <>
            <button
              type="button"
              className="zen-sidebar-row"
              aria-expanded={toolsExpanded}
              aria-controls="zen-toolbox"
              onClick={() => setToolsExpanded((expanded) => !expanded)}>
              <ChevronRight size={15} className="zen-toolbox-chevron" />
              <span>{t('app_shell.more_tools')}</span>
            </button>
            <div id="zen-toolbox" hidden={!toolsExpanded}>
              {moreEntries.map(renderNavEntry)}
              {internal?.unlocked && (
                <Link
                  className="zen-sidebar-row"
                  to={internal.state === 'ready' ? '/internal-assistant' : '/settings/general'}
                  aria-current={pathname === '/internal-assistant' ? 'page' : undefined}>
                  <FlaskConical size={15} /> <span>{t('settings.internalTesting.entry')}</span>
                </Link>
              )}
            </div>
          </>
        )}
      </nav>
      <div className="zen-sidebar-content" ref={shell.setBodySlot}>
        {!hideRecentItems && (
          <AgentWorkspaceContext value="opencode">
            <RecentItems />
          </AgentWorkspaceContext>
        )}
      </div>
    </div>
  )
}
