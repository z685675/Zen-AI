import type { Assistant, Topic } from '@renderer/types'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useActiveTopic } from '../useTopic'

const mocks = vi.hoisted(() => ({
  assistant: undefined as Assistant | undefined,
  dispatch: vi.fn(),
  emit: vi.fn()
}))

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: mocks.dispatch
  }
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: new Proxy({}, { get: (_, key) => String(key) }),
  EventEmitter: {
    emit: mocks.emit,
    off: vi.fn(),
    on: vi.fn(() => vi.fn())
  }
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  loadTopicMessagesThunk: (topicId: string) => ({ type: 'messages/loadTopic', payload: topicId })
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopic: (payload: unknown) => ({ type: 'assistants/updateTopic', payload })
}))

vi.mock('../useAssistant', () => ({
  useAssistant: () => ({ assistant: mocks.assistant })
}))

const makeTopic = (id: string, assistantId: string): Topic =>
  ({
    id,
    assistantId,
    name: id,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z'
  }) as Topic

const makeAssistant = (id: string, topics: Topic[]): Assistant =>
  ({
    id,
    name: id,
    topics,
    settings: {}
  }) as Assistant

describe('useActiveTopic', () => {
  beforeEach(() => {
    mocks.dispatch.mockClear()
    mocks.emit.mockClear()
  })

  it('does not let the previous assistant overwrite a newly selected cross-assistant topic', async () => {
    const topicA = makeTopic('topic-a', 'assistant-a')
    const topicB = makeTopic('topic-b', 'assistant-b')
    mocks.assistant = makeAssistant('assistant-a', [topicA])

    const { result, rerender } = renderHook(({ assistantId }) => useActiveTopic(assistantId, topicA), {
      initialProps: { assistantId: 'assistant-a' }
    })

    act(() => {
      result.current.setActiveTopic(topicB)
    })

    await waitFor(() => {
      expect(result.current.activeTopic?.id).toBe(topicB.id)
    })

    mocks.assistant = makeAssistant('assistant-b', [topicB])
    rerender({ assistantId: 'assistant-b' })

    expect(result.current.activeTopic?.id).toBe(topicB.id)
  })
})
