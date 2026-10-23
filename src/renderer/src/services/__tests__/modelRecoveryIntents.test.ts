import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  modelRecoveryIntents,
  modelRecoverySelectionMiddleware,
  withAutomaticModelChange
} from '../modelRecoveryIntents'

describe('model-selection intent vs automatic changes', () => {
  it('notifies read-only subscribers without starting reconciliation', () => {
    const changed = vi.fn()
    const unsubscribe = modelRecoveryIntents.subscribe(changed)
    modelRecoveryIntents.set('topic:t', { preferred: 'p:A', actual: 'p:B' })
    expect(changed).toHaveBeenCalledTimes(1)
    modelRecoveryIntents.set('topic:t', { preferred: 'p:A', actual: 'p:B' })
    expect(changed).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
  const next = vi.fn((action) => action)
  const dispatch = modelRecoverySelectionMiddleware({} as any)(next)
  beforeEach(() => {
    next.mockClear()
    modelRecoveryIntents.set('global:chat', undefined)
    modelRecoveryIntents.set('topic:t', undefined)
  })
  it('clears the previous preference even when the user explicitly selects the same temporary B', () => {
    modelRecoveryIntents.set('global:chat', { preferred: 'p:A', actual: 'p:B' })
    dispatch({ type: 'llm/setDefaultModel', payload: { model: { provider: 'p', id: 'B' } } })
    expect(modelRecoveryIntents.get('global:chat')).toBeUndefined()
  })
  it('preserves intent for automatic repairs and labels cross-window actions', () => {
    modelRecoveryIntents.set('global:chat', { preferred: 'p:A', actual: 'p:B' })
    withAutomaticModelChange(() => dispatch({ type: 'llm/setDefaultModel', payload: {} }))
    expect(next.mock.calls[0][0].meta.automaticModelRepair).toBe(true)
    expect(modelRecoveryIntents.get('global:chat')?.preferred).toBe('p:A')
    dispatch({ type: 'llm/setDefaultModel', meta: { fromSync: true, automaticModelRepair: true }, payload: {} })
    expect(modelRecoveryIntents.get('global:chat')?.preferred).toBe('p:A')
  })
  it('does not treat a routine save of the current topic as a manual model choice', () => {
    modelRecoveryIntents.set('topic:t', { preferred: 'p:A', actual: 'p:B' })
    dispatch({ type: 'assistants/updateTopic', payload: { topic: { id: 't', model: { id: 'B', provider: 'p' } } } })
    expect(modelRecoveryIntents.get('topic:t')?.preferred).toBe('p:A')
  })
  it('accepts a new remote default even when it equals the temporary B', () => {
    modelRecoveryIntents.set('global:chat', { preferred: 'p:A', actual: 'p:B' })
    dispatch({ type: 'llm/applyRemoteModelPolicy', payload: { defaultModel: { provider: 'p', id: 'B' } } })
    expect(modelRecoveryIntents.get('global:chat')).toBeUndefined()
  })
  it('inherits the original default for a new conversation during an outage', () => {
    modelRecoveryIntents.set('global:chat', { preferred: 'p:A', actual: 'p:B', unavailableAt: 1 })
    const state = {
      assistants: { assistants: [{ id: 'default', topics: [] }] },
      llm: { defaultModel: { provider: 'p', id: 'B' } }
    }
    const create = modelRecoverySelectionMiddleware({ getState: () => state } as any)(next)
    create({
      type: 'assistants/addTopic',
      payload: { assistantId: 'default', topic: { id: 't', model: state.llm.defaultModel } }
    })
    expect(modelRecoveryIntents.get('topic:t')).toMatchObject({ preferred: 'p:A', actual: 'p:B' })
    // An explicit choice of B supersedes the previous global intent.
    dispatch({ type: 'llm/setDefaultModel', payload: { model: state.llm.defaultModel } })
    modelRecoveryIntents.set('topic:t', undefined)
    create({
      type: 'assistants/addTopic',
      payload: { assistantId: 'default', topic: { id: 't', model: state.llm.defaultModel } }
    })
    expect(modelRecoveryIntents.get('topic:t')).toBeUndefined()
  })
})
