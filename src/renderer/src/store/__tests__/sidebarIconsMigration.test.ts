import { DEFAULT_DISABLED_SIDEBAR_ICONS, DEFAULT_SIDEBAR_ICONS } from '@renderer/config/sidebar'
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

  describe('migration 211: simplify primary sidebar order', () => {
    const migrate211 = (state: any) => {
      const primarySidebarIcons = DEFAULT_SIDEBAR_ICONS
      const hiddenSidebarIcons = new Set(['openclaw', 'store', 'minapp', 'code_tools'])
      const disabledIcons = state.settings.sidebarIcons?.disabled ?? []
      const hiddenIcons = [...new Set([...disabledIcons, ...DEFAULT_DISABLED_SIDEBAR_ICONS])]

      state.settings.sidebarIcons = {
        visible: primarySidebarIcons,
        disabled: hiddenIcons.filter((icon: string) => hiddenSidebarIcons.has(icon))
      }

      return state
    }

    const migrate = createMigrate({ '211': migrate211 as any })

    it('keeps only the core image-generation workflow entries in the requested order', async () => {
      const state = {
        settings: {
          sidebarIcons: {
            visible: ['assistants', 'store', 'translate', 'paintings', 'openclaw', 'notes'],
            disabled: ['minapp']
          }
        },
        _persist: { version: 210, rehydrated: false }
      }

      const migrated: any = await migrate(state, 211)

      expect(migrated.settings.sidebarIcons.visible).toEqual([
        'assistants',
        'agents',
        'translate',
        'notes',
        'knowledge',
        'files',
        'paintings'
      ])
      expect(migrated.settings.sidebarIcons.disabled).toEqual(['minapp', 'openclaw', 'store', 'code_tools'])
    })
  })
})
