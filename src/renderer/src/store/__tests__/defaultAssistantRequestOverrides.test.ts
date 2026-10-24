import { DEFAULT_ASSISTANT_SETTINGS, getAssistantSettings } from '@renderer/services/AssistantService'
import type { Assistant } from '@renderer/types'
import { createMigrate } from 'redux-persist'
import { describe, expect, it, vi } from 'vitest'

import { resetDefaultAssistantRequestOverrides } from '../migrations/defaultAssistantRequestOverrides'

vi.mock('@renderer/store', () => ({ default: { getState: () => ({ llm: { providers: [] } }) } }))
vi.mock('@renderer/store/assistants', () => ({ updateAssistant: vi.fn(), updateDefaultAssistant: vi.fn() }))

const settings = {
  ...DEFAULT_ASSISTANT_SETTINGS,
  enableTemperature: true,
  enableTopP: true,
  enableMaxTokens: true,
  temperature: 0.35,
  topP: 0.75,
  maxTokens: 32768
}
const createState = () => ({
  assistants: {
    defaultAssistant: { id: 'default', name: 'My assistant', model: { id: 'my-model' }, settings: { ...settings } },
    assistants: [
      { id: 'default', settings: { ...settings }, topics: [{ id: 'history', model: { id: 'topic-model' } }] },
      { id: 'custom-role', settings: { ...settings } },
      { id: 'zen-opencode-default', settings: { ...settings } }
    ]
  },
  llm: { defaultModel: { id: 'user-default' } },
  _persist: { version: 227, rehydrated: false }
})

describe('default request override upgrade repair', () => {
  it('turns off the three default switches while preserving values, models, history and custom roles', () => {
    const state = createState()
    const original = structuredClone(state)
    expect(resetDefaultAssistantRequestOverrides(state)).toBe(state)
    const expected = { ...settings, enableTemperature: false, enableTopP: false, enableMaxTokens: false }
    expect(state.assistants.defaultAssistant).toEqual({ ...original.assistants.defaultAssistant, settings: expected })
    expect(state.assistants.assistants[0]).toEqual({ ...original.assistants.assistants[0], settings: expected })
    expect(state.assistants.assistants.slice(1)).toEqual(original.assistants.assistants.slice(1))
    expect(state.llm).toEqual(original.llm)
    expect(getAssistantSettings(state.assistants.defaultAssistant as Assistant)).toMatchObject({
      enableTemperature: false,
      enableTopP: false,
      enableMaxTokens: false,
      maxTokens: undefined
    })
  })
  it('runs for existing installations but does not reset user opt-ins after migration', async () => {
    const migrate = createMigrate({ '228': resetDefaultAssistantRequestOverrides as any })
    const state = createState()
    const result: any = await migrate(state, 228)
    expect(result.assistants.defaultAssistant.settings.enableTopP).toBe(false)
    // redux-persist writes the target version when storing the rehydrated state.
    result._persist.version = 228
    Object.assign(result.assistants.defaultAssistant.settings, {
      enableTemperature: true,
      enableTopP: true,
      enableMaxTokens: true
    })
    await migrate(result, 228)
    expect(result.assistants.defaultAssistant.settings).toMatchObject({
      enableTemperature: true,
      enableTopP: true,
      enableMaxTokens: true
    })
    expect(await migrate(undefined, 228)).toBeUndefined()
  })
  it('safely handles missing old fields and fresh installations already default to off', () => {
    const minimal = { assistants: { defaultAssistant: {}, assistants: [{ id: 'default' }] } }
    expect(resetDefaultAssistantRequestOverrides(minimal).assistants.defaultAssistant).toEqual({
      settings: { enableTemperature: false, enableTopP: false, enableMaxTokens: false }
    })
    expect(resetDefaultAssistantRequestOverrides({})).toEqual({})
    expect(DEFAULT_ASSISTANT_SETTINGS).toMatchObject({
      enableTemperature: false,
      enableTopP: false,
      enableMaxTokens: false
    })
  })
})
