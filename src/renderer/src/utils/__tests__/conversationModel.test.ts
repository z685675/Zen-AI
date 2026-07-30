import type { Assistant, Model, Topic } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { getNewConversationModel, getTopicConversationModel, isSameModel } from '../conversationModel'

const oldModel = { id: 'gpt-5.4', provider: 'zen', name: 'GPT 5.4', group: 'OpenAI' } satisfies Model
const lunaModel = {
  id: 'gpt-5.6-luna',
  provider: 'zen',
  name: 'GPT 5.6 Luna',
  group: 'OpenAI'
} satisfies Model
const customModel = { id: 'claude-opus-4-6', provider: 'zen', name: 'Claude', group: 'Anthropic' } satisfies Model

const createAssistant = (overrides: Partial<Assistant> = {}): Assistant => ({
  id: 'default',
  name: 'Default',
  prompt: '',
  topics: [],
  type: 'assistant',
  model: oldModel,
  ...overrides
})

const createTopic = (model?: Model): Topic => ({
  id: 'topic-1',
  assistantId: 'default',
  name: 'Topic',
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
  messages: [],
  model
})

describe('conversation model policy', () => {
  it('uses the current global default for a new default-assistant conversation', () => {
    expect(getNewConversationModel(createAssistant(), lunaModel)).toBe(lunaModel)
  })

  it('keeps an explicitly configured model for a specialized assistant', () => {
    const assistant = createAssistant({ id: 'writer', model: customModel })

    expect(getNewConversationModel(assistant, lunaModel)).toBe(customModel)
  })

  it('keeps a historical topic model while a new topic can use Luna', () => {
    const assistant = createAssistant()

    expect(getTopicConversationModel(createTopic(oldModel), assistant, lunaModel)).toBe(oldModel)
    expect(getTopicConversationModel(createTopic(lunaModel), assistant, oldModel)).toBe(lunaModel)
  })

  it('falls back to the historical assistant model for topics created before model snapshots existed', () => {
    expect(getTopicConversationModel(createTopic(), createAssistant(), lunaModel)).toBe(oldModel)
  })

  it('compares both provider and model id', () => {
    expect(isSameModel(lunaModel, { ...lunaModel })).toBe(true)
    expect(isSameModel(lunaModel, { ...lunaModel, provider: 'other' })).toBe(false)
  })
})
