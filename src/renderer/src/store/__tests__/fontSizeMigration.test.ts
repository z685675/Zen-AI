import { createMigrate } from 'redux-persist'
import { describe, expect, it } from 'vitest'

describe('font size migration', () => {
  const migrate225 = (state: any) => {
    if (state.settings.fontSize === 14) {
      state.settings.fontSize = 12
    }

    return state
  }

  const migrate = createMigrate({ '225': migrate225 as any })

  it('reduces the previous default message font size to 12', async () => {
    const state = {
      settings: { fontSize: 14 },
      _persist: { version: 224, rehydrated: false }
    }

    const migrated: any = await migrate(state, 225)

    expect(migrated.settings.fontSize).toBe(12)
  })

  it('preserves a custom message font size', async () => {
    const state = {
      settings: { fontSize: 18 },
      _persist: { version: 224, rehydrated: false }
    }

    const migrated: any = await migrate(state, 225)

    expect(migrated.settings.fontSize).toBe(18)
  })
})
