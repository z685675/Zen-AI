import type { Assistant } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/hooks/useTopic', () => ({ TopicManager: {} }))
vi.mock('@renderer/services/AssistantService', () => ({
  DEFAULT_ASSISTANT_SETTINGS: {},
  getDefaultAssistant: () => ({ id: 'default', name: 'Default', prompt: 'Existing default prompt', topics: [] }),
  getDefaultTopic: vi.fn()
}))

import reducer, { updateAssistant, updateAssistants, updateDefaultAssistant } from '../assistants'

function createState() {
  const state = reducer(undefined, { type: '@@init' })
  return {
    ...state,
    assistants: [state.defaultAssistant, { ...state.defaultAssistant, id: 'custom', prompt: 'Custom role prompt' }]
  }
}

describe('default conversation prompt protection', () => {
  it('keeps the default template prompt while saving other settings without mutating the payload', () => {
    const state = createState()
    const incoming = {
      ...state.defaultAssistant,
      name: 'New name',
      prompt: 'Attempted override',
      mcpMode: 'auto'
    } as Assistant
    const next = reducer(state, updateDefaultAssistant({ assistant: incoming }))
    expect(next.defaultAssistant).toMatchObject({
      name: 'New name',
      prompt: 'Existing default prompt',
      mcpMode: 'auto'
    })
    expect(incoming.prompt).toBe('Attempted override')
  })

  it('protects the default role during individual updates while allowing custom role prompts', () => {
    const state = createState()
    const changedDefault = reducer(state, updateAssistant({ id: 'default', name: 'New name', prompt: '' }))
    expect(changedDefault.assistants[0]).toMatchObject({ name: 'New name', prompt: 'Existing default prompt' })
    const changedCustom = reducer(changedDefault, updateAssistant({ id: 'custom', prompt: 'Edited custom prompt' }))
    expect(changedCustom.assistants[1].prompt).toBe('Edited custom prompt')
  })

  it('protects the default prompt during bulk updates while retaining ordering and custom edits', () => {
    const state = createState()
    const incoming = [
      { ...state.assistants[1], prompt: 'Updated custom prompt' },
      { ...state.assistants[0], name: 'Renamed', prompt: 'Attempted override' }
    ]
    const next = reducer(state, updateAssistants(incoming))
    expect(next.assistants.map(({ id, prompt }) => ({ id, prompt }))).toEqual([
      { id: 'custom', prompt: 'Updated custom prompt' },
      { id: 'default', prompt: 'Existing default prompt' }
    ])
    expect(next.assistants[1].name).toBe('Renamed')
    expect(incoming[1].prompt).toBe('Attempted override')
  })
})
