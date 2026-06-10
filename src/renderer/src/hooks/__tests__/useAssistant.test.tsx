import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDispatch = vi.fn()

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (state: any) => unknown) => selector(mockState)
}))

vi.mock('@renderer/databases', () => ({
  db: {
    topics: {
      where: vi.fn()
    }
  }
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultAssistant: () => ({
    id: 'default',
    name: '默认助手',
    topics: [],
    settings: {}
  }),
  getDefaultTopic: (assistantId: string) => ({
    id: 'topic-1',
    assistantId,
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    name: '新话题',
    messages: [],
    isNameManuallyEdited: false
  })
}))

vi.mock('@renderer/store/assistants', () => ({
  addAssistant: vi.fn((payload) => payload),
  addTopic: vi.fn((payload) => payload),
  insertAssistant: vi.fn((payload) => payload),
  removeAllTopics: vi.fn((payload) => payload),
  removeAssistant: vi.fn((payload) => payload),
  removeTopic: vi.fn((payload) => payload),
  setModel: vi.fn((payload) => payload),
  updateAssistant: vi.fn((payload) => payload),
  updateAssistants: vi.fn((payload) => payload),
  updateAssistantSettings: vi.fn((payload) => payload),
  updateDefaultAssistant: vi.fn((payload) => payload),
  updateTopic: vi.fn((payload) => payload),
  updateTopics: vi.fn((payload) => payload)
}))

vi.mock('@renderer/store/llm', () => ({
  setDefaultModel: vi.fn((payload) => payload),
  setQuickModel: vi.fn((payload) => payload),
  setTranslateModel: vi.fn((payload) => payload)
}))

let mockState: any

describe('useAssistant', () => {
  beforeEach(() => {
    mockDispatch.mockClear()
    mockState = {
      assistants: {
        assistants: [
          {
            id: 'default',
            name: '默认助手',
            topics: [],
            settings: {}
          }
        ]
      },
      llm: {
        providers: [],
        defaultModel: undefined,
        quickModel: undefined,
        translateModel: undefined
      }
    }
  })

  it('does not crash on a fresh install before any model is configured', async () => {
    const { useAssistant } = await import('../useAssistant')

    const { result } = renderHook(() => useAssistant('default'))

    expect(result.current.assistant.id).toBe('default')
    expect(result.current.model).toBeUndefined()
    expect(mockDispatch).not.toHaveBeenCalled()
  })
})
