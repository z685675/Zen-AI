import type { SidebarIcon } from '@renderer/types'

export const ALL_SIDEBAR_ICONS: SidebarIcon[] = [
  'assistants',
  'agents',
  'store',
  'translate',
  'notes',
  'knowledge',
  'files',
  'minapp',
  'paintings',
  'code_tools',
  'openclaw'
]

export const DEFAULT_DISABLED_SIDEBAR_ICONS: SidebarIcon[] = ['store', 'minapp', 'code_tools']

export const DEFAULT_SIDEBAR_ICONS: SidebarIcon[] = ALL_SIDEBAR_ICONS.filter(
  (icon) => !DEFAULT_DISABLED_SIDEBAR_ICONS.includes(icon)
)

export const REQUIRED_SIDEBAR_ICONS: SidebarIcon[] = ['assistants']

export const getAvailableSidebarIcons = (
  visibleIcons: SidebarIcon[],
  disabledIcons: SidebarIcon[] = [],
  _enableDeveloperMode = false
) => {
  const legacyDisabledIcons = new Set<string>(disabledIcons)
  return (visibleIcons as string[]).filter(
    (icon) =>
      !legacyDisabledIcons.has(icon) &&
      icon !== 'research' &&
      icon !== 'task_agent' &&
      icon !== 'task-agent'
  ) as SidebarIcon[]
}
