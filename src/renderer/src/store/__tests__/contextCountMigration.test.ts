import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
import { createMigrate } from 'redux-persist'
import { describe, expect, it } from 'vitest'

describe('context count migration', () => {
  describe('migration 209: default context count backfill', () => {
    const migrate209 = (state: any) => {
      const previousDefaultContextCount = 5
      const nextDefaultContextCount = DEFAULT_CONTEXTCOUNT

      if (state.assistants?.defaultAssistant?.settings?.contextCount === previousDefaultContextCount) {
        state.assistants.defaultAssistant.settings.contextCount = nextDefaultContextCount
      }

      state.assistants?.assistants?.forEach((assistant: any) => {
        if (assistant.settings?.contextCount === previousDefaultContextCount) {
          assistant.settings.contextCount = nextDefaultContextCount
        }
      })

      return state
    }

    const migrate = createMigrate({ '209': migrate209 as any })

    it('upgrades legacy default context counts from 5 to the new default', async () => {
      const state = {
        assistants: {
          defaultAssistant: {
            settings: { contextCount: 5 }
          },
          assistants: [
            { id: 'a1', settings: { contextCount: 5 } },
            { id: 'a2', settings: { contextCount: 12 } }
          ]
        },
        _persist: { version: 208, rehydrated: false }
      }

      const migrated: any = await migrate(state, 209)

      expect(migrated.assistants.defaultAssistant.settings.contextCount).toBe(DEFAULT_CONTEXTCOUNT)
      expect(migrated.assistants.assistants[0].settings.contextCount).toBe(DEFAULT_CONTEXTCOUNT)
      expect(migrated.assistants.assistants[1].settings.contextCount).toBe(12)
    })
  })
})
