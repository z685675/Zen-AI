import type { SidebarIcon } from '@renderer/types'

import { researchWorkspace } from './researchWorkspace'

/**
 * 默认显示的侧边栏图标
 * 这些图标会在侧边栏中默认显示
 */
export const DEFAULT_SIDEBAR_ICONS: SidebarIcon[] = [
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

/**
 * 必须显示的侧边栏图标（不能被隐藏）
 * 这些图标必须始终在侧边栏中可见
 * 抽取为参数方便未来扩展
 */
export const REQUIRED_SIDEBAR_ICONS: SidebarIcon[] = ['assistants']

export const getAvailableSidebarIcons = (visibleIcons: SidebarIcon[], disabledIcons: SidebarIcon[] = []) => {
  if (!researchWorkspace.enabled) {
    return visibleIcons.filter((icon) => icon !== 'research')
  }

  if (disabledIcons.includes('research')) {
    return visibleIcons.filter((icon) => icon !== 'research')
  }

  if (visibleIcons.includes('research')) {
    return visibleIcons
  }

  const nextIcons = [...visibleIcons]
  const insertAfter = nextIcons.indexOf('notes')
  nextIcons.splice(insertAfter >= 0 ? insertAfter + 1 : nextIcons.length, 0, 'research')

  return nextIcons
}
