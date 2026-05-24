import { DEFAULT_DISABLED_SIDEBAR_ICONS } from '@renderer/config/sidebar'
import { createMigrate } from 'redux-persist'
import { describe, expect, it } from 'vitest'

describe('sidebar icons migration', () => {
  describe('migration 210: hide optional sidebar entries by default', () => {
    const migrate210 = (state: any) => {
      const hiddenByDefault = new Set(DEFAULT_DISABLED_SIDEBAR_ICONS)
      const visibleIcons = state.settings.sidebarIcons?.visible ?? []
      const disabledIcons = state.settings.sidebarIcons?.disabled ?? []

      state.settings.sidebarIcons = {
        visible: visibleIcons.filter((icon: string) => !hiddenByDefault.has(icon as any)),
        disabled: [...new Set([...disabledIcons, ...DEFAULT_DISABLED_SIDEBAR_ICONS])]
      }

      return state
    }

    const migrate = createMigrate({ '210': migrate210 as any })

    it('moves store, minapp, and code tools into the disabled list on upgrade', async () => {
      const state = {
        settings: {
          sidebarIcons: {
            visible: ['assistants', 'store', 'translate', 'minapp', 'code_tools', 'paintings'],
            disabled: ['openclaw']
          }
        },
        _persist: { version: 209, rehydrated: false }
      }

      const migrated: any = await migrate(state, 210)

      expect(migrated.settings.sidebarIcons.visible).toEqual(['assistants', 'translate', 'paintings'])
      expect(migrated.settings.sidebarIcons.disabled).toEqual(['openclaw', 'store', 'minapp', 'code_tools'])
    })
  })

  describe('migration 211: remove legacy task agent sidebar entries', () => {
    const migrate211 = (state: any) => {
      const hiddenByDefault = new Set(DEFAULT_DISABLED_SIDEBAR_ICONS)
      const legacyHiddenIcons = new Set(['research', 'task_agent', 'task-agent'])
      const visibleIcons = (state.settings.sidebarIcons?.visible ?? []).filter(
        (icon: string) => !legacyHiddenIcons.has(icon)
      )
      const disabledIcons = state.settings.sidebarIcons?.disabled ?? []

      state.settings.sidebarIcons = {
        visible: visibleIcons.filter((icon: string) => !hiddenByDefault.has(icon as any)),
        disabled: [...new Set([...disabledIcons, ...DEFAULT_DISABLED_SIDEBAR_ICONS])]
      }

      return state
    }

    const migrate = createMigrate({ '211': migrate211 as any })

    it('removes task agent and research entries from visible sidebar icons', async () => {
      const state = {
        settings: {
          sidebarIcons: {
            visible: ['assistants', 'task_agent', 'task-agent', 'research', 'agents', 'minapp'],
            disabled: ['openclaw']
          }
        },
        _persist: { version: 210, rehydrated: false }
      }

      const migrated: any = await migrate(state, 211)

      expect(migrated.settings.sidebarIcons.visible).toEqual(['assistants', 'agents'])
      expect(migrated.settings.sidebarIcons.disabled).toEqual(['openclaw', 'store', 'minapp', 'code_tools'])
    })
  })
})
