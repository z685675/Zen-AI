import type { Middleware } from '@reduxjs/toolkit'
import type { RootState } from '@renderer/store'
import type { ModelRecoveryIntent } from '@shared/config/modelRecovery'

const KEY = 'zen:model-recovery-intents:v1'
let automaticDepth = 0
let records: Record<string, ModelRecoveryIntent> = {}
const listeners = new Set<() => void>()
function reloadIntents(): void {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      records = Object.fromEntries(
        Object.entries(parsed).filter(
          ([, value]) =>
            value &&
            typeof value === 'object' &&
            typeof (value as ModelRecoveryIntent).preferred === 'string' &&
            ((value as ModelRecoveryIntent).actual === null ||
              typeof (value as ModelRecoveryIntent).actual === 'string')
        )
      ) as Record<string, ModelRecoveryIntent>
    }
  } catch {
    /* Safe empty intent on corrupt/disabled storage. */
  }
}
reloadIntents()

export const modelRecoveryIntents = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  get: (slot: string): ModelRecoveryIntent | undefined => records[slot],
  set: (slot: string, value: ModelRecoveryIntent | undefined) => {
    if (JSON.stringify(records[slot]) === JSON.stringify(value)) return
    if (value) records[slot] = value
    else delete records[slot]
    try {
      localStorage.setItem(KEY, JSON.stringify(records))
    } catch {
      /* Recovery still works in memory. */
    }
    for (const listener of listeners) listener()
  }
}

export function withAutomaticModelChange<T>(operation: () => T): T {
  automaticDepth++
  try {
    return operation()
  } finally {
    automaticDepth--
  }
}

// Observe explicit setters, even if the user selects the SAME temporary model.
// No Redux persisted shape/schema changes are needed for intent bookkeeping.
export const modelRecoverySelectionMiddleware: Middleware = (api) => (next) => (action) => {
  if (!action || typeof action !== 'object') return next(action)
  if (automaticDepth) return next(automaticModelAction(action as { type: string }))
  const typed = action as { type?: string; payload?: Record<string, any>; meta?: Record<string, unknown> }
  if (typed.meta?.automaticModelRepair) {
    reloadIntents()
    for (const listener of listeners) listener()
    return next(action)
  }
  const { type, payload } = typed
  const global = (
    { 'llm/setDefaultModel': 'chat', 'llm/setQuickModel': 'quick', 'llm/setTranslateModel': 'translate' } as Record<
      string,
      string
    >
  )[type ?? '']
  if (global) modelRecoveryIntents.set(`global:${global}`, undefined)
  if (type === 'llm/applyRemoteModelPolicy') {
    for (const [field, slot] of [
      ['defaultModel', 'chat'],
      ['quickModel', 'quick'],
      ['translateModel', 'translate']
    ]) {
      if (payload?.[field]) modelRecoveryIntents.set(`global:${slot}`, undefined)
    }
  }
  if (type === 'assistants/setModel' && payload?.assistantId) {
    modelRecoveryIntents.set(`assistant:${payload.assistantId}:model`, undefined)
  }
  if (type === 'assistants/updateAssistant' && payload?.id) {
    for (const field of ['model', 'defaultModel'])
      if (Object.hasOwn(payload, field)) modelRecoveryIntents.set(`assistant:${payload.id}:${field}`, undefined)
  }
  if (type === 'assistants/updateTopic' && payload?.topic?.id && Object.hasOwn(payload.topic, 'model')) {
    // Routine topic saves carry the full topic. Different choices are also
    // detected by the resolver; explicit same-model setters use setModel above.
    const slot = `topic:${payload.topic.id}`
    const intent = modelRecoveryIntents.get(slot)
    const current = payload.topic.model ? `${payload.topic.model.provider}:${payload.topic.model.id}` : null
    if (intent && current !== intent.actual) modelRecoveryIntents.set(slot, undefined)
  }
  if (type === 'assistants/addTopic' && payload?.topic?.id && payload.topic.model) {
    const state = api.getState() as RootState
    const assistant = state.assistants.assistants.find((entry) => entry.id === payload.assistantId)
    const topic = payload.topic
    // A new conversation inherits the default's original intent, not merely
    // its temporary B. Moving an existing topic must preserve its own intent.
    if (assistant && !state.assistants.assistants.some((entry) => entry.topics?.some((item) => item.id === topic.id))) {
      const sources = [
        [`assistant:${assistant.id}:defaultModel`, assistant.defaultModel],
        [`assistant:${assistant.id}:model`, assistant.model]
      ] as const
      const global = ['global:chat', state.llm.defaultModel] as const
      const source = (assistant.id === 'default' ? [global, ...sources] : [...sources, global]).find(
        ([, model]) => model
      )
      const intent = source && modelRecoveryIntents.get(source[0])
      const actual = `${topic.model.provider}:${topic.model.id}`
      if (
        source &&
        intent?.actual === actual &&
        source[1]?.provider === topic.model.provider &&
        source[1].id === topic.model.id
      ) {
        modelRecoveryIntents.set(`topic:${topic.id}`, { ...intent })
      }
    }
  }
  return next(action)
}

/** Metadata travels with the synced action; another window must not treat an
 * automatic fallback as a new explicit user preference. */
export const automaticModelAction = <T extends { type: string }>(
  action: T
): T & { meta: { automaticModelRepair: true } } => ({ ...action, meta: { automaticModelRepair: true } })
