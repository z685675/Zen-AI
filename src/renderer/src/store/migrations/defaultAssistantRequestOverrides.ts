import type { AssistantSettings } from '@renderer/types'

type RequestOverrideState = {
  assistants?: {
    defaultAssistant?: { settings?: Partial<AssistantSettings> }
    assistants?: Array<{ id: string; settings?: Partial<AssistantSettings> }>
  }
}

/** One-time upgrade repair, not a runtime policy overriding later user choices. */
export function resetDefaultAssistantRequestOverrides<T extends RequestOverrideState>(state: T): T {
  const candidates = [
    state.assistants?.defaultAssistant,
    ...(state.assistants?.assistants?.filter((assistant) => assistant.id === 'default') ?? [])
  ]
  for (const assistant of candidates) {
    if (!assistant) continue
    assistant.settings = {
      ...assistant.settings,
      enableTemperature: false,
      enableTopP: false,
      enableMaxTokens: false
    }
  }
  return state
}
