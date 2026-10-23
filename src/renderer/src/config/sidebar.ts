import type { SidebarIcon } from '@renderer/types'

export const ALL_SIDEBAR_ICONS: SidebarIcon[] = [
  'assistants',
  'new_assistant',
  'translate',
  'notes',
  'knowledge',
  'files',
  'paintings',
  'openclaw',
  'store',
  'minapp',
  'code_tools',
  'agents',
  'usage'
]

export const DEFAULT_DISABLED_SIDEBAR_ICONS: SidebarIcon[] = ['knowledge', 'openclaw', 'store', 'minapp', 'code_tools']

export const DEFAULT_SIDEBAR_ICONS: SidebarIcon[] = ALL_SIDEBAR_ICONS.filter(
  (icon) => !DEFAULT_DISABLED_SIDEBAR_ICONS.includes(icon)
)

export const REQUIRED_SIDEBAR_ICONS: SidebarIcon[] = ['assistants']

export const getAvailableSidebarIcons = (
  visibleIcons: SidebarIcon[],
  disabledIcons: SidebarIcon[] = [],
  enableDeveloperMode = false
) => {
  void enableDeveloperMode
  const legacyDisabledIcons = new Set<string>(disabledIcons)
  const icons = [...new Set(visibleIcons)].filter(
    (icon) => !legacyDisabledIcons.has(icon) && ALL_SIDEBAR_ICONS.includes(icon)
  )
  if (!legacyDisabledIcons.has('new_assistant') && !icons.includes('new_assistant')) {
    icons.push('new_assistant')
  }
  if (!legacyDisabledIcons.has('usage') && !icons.includes('usage')) icons.push('usage')
  // Apply to persisted layouts too, without resetting other entries or visibility.
  const ordered: SidebarIcon[] = icons.filter(
    (icon) => icon !== 'new_assistant' && icon !== 'agents' && icon !== 'usage'
  )
  if (icons.includes('new_assistant')) {
    const chatIndex = ordered.indexOf('assistants')
    ordered.splice(chatIndex < 0 ? 0 : chatIndex + 1, 0, 'new_assistant')
  }
  if (icons.includes('agents')) ordered.push('agents')
  if (icons.includes('usage')) ordered.push('usage')
  return ordered
}
