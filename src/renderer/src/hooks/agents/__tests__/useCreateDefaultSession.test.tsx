import { act, renderHook } from '@testing-library/react'
import type * as ReactI18next from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agent: null as any,
  sessions: [] as any[],
  createSession: vi.fn(),
  dispatch: vi.fn(),
  enableDeveloperMode: false,
  fetchMessages: vi.fn(),
  getAgent: vi.fn(),
  getModels: vi.fn(),
  modelPolicy: null as any,
  setActiveSessionIdAction: vi.fn((payload) => ({ type: 'runtime/setActiveSessionId', payload })),
  updateAgent: vi.fn(),
  updateSession: vi.fn()
}))

vi.mock('@renderer/hooks/agents/useAgent', () => ({
  useAgent: () => ({ agent: mocks.agent })
}))

vi.mock('@renderer/hooks/agents/useAgentClient', () => ({
  useAgentClient: () => ({ getAgent: mocks.getAgent, getModels: mocks.getModels })
}))

vi.mock('@renderer/hooks/agents/useSessions', () => ({
  useSessions: () => ({ sessions: mocks.sessions, createSession: mocks.createSession })
}))

vi.mock('@renderer/hooks/agents/useUpdateSession', () => ({
  useUpdateSession: () => ({ updateSession: mocks.updateSession })
}))

vi.mock('@renderer/hooks/agents/useUpdateAgent', () => ({
  useUpdateAgent: () => ({ updateAgent: mocks.updateAgent })
}))

vi.mock('@renderer/services/db/DbService', () => ({
  DbService: {
    getInstance: () => ({ fetchMessages: mocks.fetchMessages })
  }
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: (selector: (state: any) => unknown) =>
    selector({ llm: { modelPolicy: mocks.modelPolicy }, settings: { enableDeveloperMode: mocks.enableDeveloperMode } })
}))

vi.mock('@renderer/store/runtime', () => ({
  setActiveSessionIdAction: (payload: unknown) => mocks.setActiveSessionIdAction(payload)
}))

vi.mock('@shared/config/agents', () => ({
  canCreateAgentSession: () => true
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({
    t: (key: string) => (key === 'common.unnamed' ? 'Unnamed' : key)
  })
}))

import { CacheService } from '@renderer/services/CacheService'
import { getAgentSessionDraftCacheKey } from '@renderer/utils/agentSessionDraft'

import { useCreateDefaultSession } from '../useCreateDefaultSession'

const makeAgent = (overrides: Record<string, unknown> = {}) => ({
  id: 'agent-1',
  type: 'claude-code',
  name: 'Official Assistant',
  model: 'provider:gpt-5.6-luna',
  accessible_paths: ['C:\\workspace'],
  created_at: '2026-07-21T00:00:00.000Z',
  updated_at: '2026-07-21T00:00:00.000Z',
  ...overrides
})

const makeSession = (overrides: Record<string, unknown> = {}) => ({
  ...makeAgent(),
  id: 'session-1',
  agent_id: 'agent-1',
  agent_type: 'claude-code',
  name: 'Unnamed',
  model: 'provider:claude-opus-4-6',
  ...overrides
})

const makePolicy = (overrides: Record<string, unknown> = {}) => ({
  version: 2,
  source: 'remote',
  policy: {
    schemaVersion: 1,
    version: 2,
    defaults: {
      chat: 'gpt-6-luna',
      quick: 'gpt-6-luna',
      translate: 'gpt-6-luna',
      assistant: 'gpt-6-luna',
      assistantNewSession: 'gpt-6-luna'
    },
    assistant: {
      nonDeveloperAllowlist: ['gpt-6-luna', 'gemini-3.8-flash-high'],
      developerAllowlist: ['gpt-6-luna'],
      blockedModels: [],
      fallbackModels: ['gpt-6-luna']
    },
    rules: {
      applyToNewSessions: true,
      overwriteUserChoice: true,
      preserveExistingSessions: true,
      developerModeBypassAllowlist: false
    },
    ...overrides
  }
})

const makeModel = (id: string) => ({
  id,
  object: 'model',
  created: 0,
  name: id.slice(id.indexOf(':') + 1),
  provider: id.slice(0, id.indexOf(':')),
  owned_by: 'provider',
  provider_model_id: id.slice(id.indexOf(':') + 1)
})

describe('useCreateDefaultSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.toast = { warning: vi.fn() } as any
    CacheService.clear()
    mocks.agent = makeAgent({ model: 'provider:claude-opus-4-6' })
    mocks.modelPolicy = null
    mocks.enableDeveloperMode = false
    mocks.sessions = [makeSession()]
    mocks.fetchMessages.mockResolvedValue({ messages: [], blocks: [] })
    mocks.getAgent.mockResolvedValue(makeAgent())
    mocks.getModels.mockResolvedValue({
      data: [
        {
          id: 'provider:gpt-5.6-luna',
          object: 'model',
          created: 0,
          name: 'gpt-5.6-luna',
          owned_by: 'provider',
          provider_model_id: 'gpt-5.6-luna'
        }
      ]
    })
    mocks.createSession.mockResolvedValue(null)
    mocks.updateAgent.mockImplementation(async (form) => ({ ...makeAgent(), ...form }))
    mocks.updateSession.mockImplementation(async (form) => ({ ...mocks.sessions[0], ...form }))
  })

  it('aligns a reused empty session with the current new-conversation default model', async () => {
    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

    let session: any
    await act(async () => {
      session = await result.current.createDefaultSession()
    })

    expect(mocks.updateSession).toHaveBeenCalledWith(
      {
        id: 'session-1',
        model: 'provider:gpt-5.6-luna',
        configuration: expect.objectContaining({ reasoning_effort: 'medium' })
      },
      { showSuccessToast: false }
    )
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.getAgent).toHaveBeenCalledWith('agent-1')
    expect(session.model).toBe('provider:gpt-5.6-luna')
    expect(mocks.setActiveSessionIdAction).toHaveBeenCalledWith({ agentId: 'agent-1', sessionId: 'session-1' })
  })

  it('creates a fresh session from the agent default when the unnamed candidate already has messages', async () => {
    mocks.fetchMessages.mockResolvedValue({ messages: [{ id: 'message-1' }], blocks: [] })
    mocks.createSession.mockImplementation(async (form) => makeSession({ ...form, id: 'session-2' }))
    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

    await act(async () => {
      await result.current.createDefaultSession()
    })

    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'provider:gpt-5.6-luna',
        configuration: expect.objectContaining({ reasoning_effort: 'medium' })
      })
    )
    expect(mocks.setActiveSessionIdAction).toHaveBeenCalledWith({ agentId: 'agent-1', sessionId: 'session-2' })
  })

  it('does not invent a replacement when no imported model is available', async () => {
    mocks.getAgent.mockResolvedValue(makeAgent({ model: 'provider:gpt-5.4-mini' }))
    mocks.getModels.mockResolvedValue({ data: [] })
    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

    let session: any
    await act(async () => {
      session = await result.current.createDefaultSession()
    })

    expect(mocks.getModels).toHaveBeenCalledWith()
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(window.toast.warning).toHaveBeenCalledWith('model_setup.no_matching_model')
    expect(session).toBeNull()
  })

  it('keeps a developer-selected model when the remote default is not imported', async () => {
    mocks.enableDeveloperMode = true
    mocks.modelPolicy = makePolicy()
    mocks.getAgent.mockResolvedValue(makeAgent({ model: 'vip:claude-opus-5' }))
    mocks.getModels.mockResolvedValue({ data: [makeModel('vip:claude-opus-5')] })
    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

    await act(async () => {
      await result.current.createDefaultSession()
    })

    expect(mocks.updateSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'vip:claude-opus-5' }), {
      showSuccessToast: false
    })
    expect(window.toast.warning).not.toHaveBeenCalled()
  })

  it('does not force a newly published default onto a developer-selected model', async () => {
    mocks.enableDeveloperMode = true
    mocks.modelPolicy = makePolicy()
    mocks.getAgent.mockResolvedValue(makeAgent({ model: 'vip:claude-opus-5' }))
    mocks.getModels.mockResolvedValue({ data: [makeModel('provider:gpt-6-luna'), makeModel('vip:claude-opus-5')] })
    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

    await act(async () => {
      await result.current.createDefaultSession()
    })

    expect(mocks.updateAgent).toHaveBeenCalledWith(expect.objectContaining({ model: 'vip:claude-opus-5' }), {
      showSuccessToast: false
    })
    expect(window.toast.warning).not.toHaveBeenCalled()
  })

  it('keeps an ordinary allowed model when the panel default is missing locally', async () => {
    mocks.modelPolicy = makePolicy()
    mocks.getAgent.mockResolvedValue(makeAgent({ model: 'provider:gemini-3.8-flash-high' }))
    mocks.getModels.mockResolvedValue({ data: [makeModel('provider:gemini-3.8-flash-high')] })
    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

    await act(async () => {
      await result.current.createDefaultSession()
    })

    expect(mocks.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'provider:gemini-3.8-flash-high' }),
      { showSuccessToast: false }
    )
    expect(window.toast.warning).not.toHaveBeenCalled()
  })

  it('uses an imported allowed model if the previous default and panel fallback are missing', async () => {
    mocks.modelPolicy = makePolicy()
    mocks.getAgent.mockResolvedValue(makeAgent({ model: 'removed:claude-opus-5' }))
    mocks.getModels.mockResolvedValue({ data: [makeModel('provider:gemini-3.8-flash-high')] })
    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

    await act(async () => {
      await result.current.createDefaultSession()
    })

    expect(mocks.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'provider:gemini-3.8-flash-high' }),
      { showSuccessToast: false }
    )
    expect(window.toast.warning).not.toHaveBeenCalled()
  })

  it('still rejects models outside the panel list when developer mode is off', async () => {
    mocks.modelPolicy = makePolicy()
    mocks.getAgent.mockResolvedValue(makeAgent({ model: 'vip:claude-opus-5' }))
    mocks.getModels.mockResolvedValue({ data: [makeModel('vip:claude-opus-5')] })
    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

    await act(async () => {
      await result.current.createDefaultSession()
    })

    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(window.toast.warning).toHaveBeenCalledWith('model_setup.no_matching_model')
  })

  it('uses any imported usable model for a developer if the old Provider was removed', async () => {
    mocks.enableDeveloperMode = true
    mocks.modelPolicy = makePolicy()
    mocks.getAgent.mockResolvedValue(makeAgent({ model: 'removed:old-model' }))
    mocks.getModels.mockResolvedValue({ data: [makeModel('personal:claude-opus-5')] })
    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

    await act(async () => {
      await result.current.createDefaultSession()
    })

    expect(mocks.updateSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'personal:claude-opus-5' }), {
      showSuccessToast: false
    })
    expect(window.toast.warning).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'forces the remote default if the current model was removed (developer=%s)',
    async (developerMode) => {
      mocks.enableDeveloperMode = developerMode
      mocks.modelPolicy = makePolicy()
      mocks.modelPolicy.policy.rules.applyToNewSessions = false
      mocks.modelPolicy.policy.assistant.fallbackModels = ['gemini-3.8-flash-high']
      mocks.getAgent.mockResolvedValue(makeAgent({ model: 'provider:removed-model' }))
      mocks.getModels.mockResolvedValue({
        data: [makeModel('provider:gemini-3.8-flash-high'), makeModel('provider:gpt-6-luna')]
      })
      const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

      await act(async () => {
        await result.current.createDefaultSession()
      })

      expect(mocks.updateSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'provider:gpt-6-luna' }), {
        showSuccessToast: false
      })
      expect(window.toast.warning).not.toHaveBeenCalled()
    }
  )

  it('rechecks the normal allowlist after developer mode is switched off', async () => {
    mocks.enableDeveloperMode = true
    mocks.modelPolicy = makePolicy()
    mocks.getAgent.mockResolvedValue(makeAgent({ model: 'vip:claude-opus-5' }))
    mocks.getModels.mockResolvedValue({ data: [makeModel('vip:claude-opus-5'), makeModel('provider:gpt-6-luna')] })
    const { result, rerender } = renderHook(() => useCreateDefaultSession('agent-1'))

    await act(async () => {
      await result.current.createDefaultSession()
    })
    expect(mocks.updateSession).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'vip:claude-opus-5' }), {
      showSuccessToast: false
    })

    mocks.enableDeveloperMode = false
    rerender()
    await act(async () => {
      await result.current.createDefaultSession()
    })
    expect(mocks.updateSession).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'provider:gpt-6-luna' }), {
      showSuccessToast: false
    })
  })

  it('applies a changed remote default once when the panel enables default overwriting', async () => {
    mocks.modelPolicy = {
      version: 2,
      fetchedAt: '2026-08-18T00:00:00.000Z',
      appliedAt: '2026-08-18T00:00:00.000Z',
      source: 'remote',
      policy: {
        schemaVersion: 1,
        version: 2,
        defaults: {
          chat: 'gpt-5.6-luna',
          quick: 'gpt-5.6-luna',
          translate: 'gpt-5.6-luna',
          assistant: 'gpt-5.6-luna',
          assistantNewSession: 'gpt-5.6-luna'
        },
        assistant: {
          nonDeveloperAllowlist: ['gpt-5.6-luna', 'grok-4.5'],
          developerAllowlist: [],
          blockedModels: [],
          fallbackModels: []
        },
        rules: {
          applyToNewSessions: true,
          overwriteUserChoice: true,
          preserveExistingSessions: true,
          developerModeBypassAllowlist: true
        }
      }
    }
    mocks.getAgent.mockResolvedValue(makeAgent({ model: 'provider:grok-4.5' }))

    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))
    await act(async () => {
      await result.current.createDefaultSession()
    })

    expect(mocks.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1', model: 'provider:gpt-5.6-luna' }),
      { showSuccessToast: false }
    )
    expect(mocks.updateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent-1',
        model: 'provider:gpt-5.6-luna',
        configuration: expect.objectContaining({
          remote_default_model_policy_version: 2,
          remote_default_model_policy_target: 'gpt-5.6-luna'
        })
      }),
      { showSuccessToast: false }
    )
  })

  it('keeps a user-selected Agent default after the same remote policy version was already applied', async () => {
    mocks.modelPolicy = {
      version: 2,
      fetchedAt: '2026-08-18T00:00:00.000Z',
      appliedAt: '2026-08-18T00:00:00.000Z',
      source: 'remote',
      policy: {
        schemaVersion: 1,
        version: 2,
        defaults: {
          chat: 'gpt-5.6-luna',
          quick: 'gpt-5.6-luna',
          translate: 'gpt-5.6-luna',
          assistant: 'gpt-5.6-luna',
          assistantNewSession: 'gpt-5.6-luna'
        },
        assistant: {
          nonDeveloperAllowlist: ['gpt-5.6-luna', 'grok-4.5'],
          developerAllowlist: [],
          blockedModels: [],
          fallbackModels: []
        },
        rules: {
          applyToNewSessions: true,
          overwriteUserChoice: true,
          preserveExistingSessions: true,
          developerModeBypassAllowlist: true
        }
      }
    }
    mocks.getAgent.mockResolvedValue(
      makeAgent({
        model: 'provider:grok-4.5',
        configuration: {
          permission_mode: 'default',
          max_turns: 100,
          env_vars: {},
          remote_default_model_policy_version: 2,
          remote_default_model_policy_target: 'gpt-5.6-luna'
        }
      })
    )
    mocks.getModels.mockResolvedValue({
      data: [
        {
          id: 'provider:gpt-5.6-luna',
          object: 'model',
          created: 0,
          name: 'gpt-5.6-luna',
          owned_by: 'provider',
          provider_model_id: 'gpt-5.6-luna'
        },
        {
          id: 'provider:grok-4.5',
          object: 'model',
          created: 0,
          name: 'grok-4.5',
          owned_by: 'provider',
          provider_model_id: 'grok-4.5'
        }
      ]
    })

    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))
    await act(async () => {
      await result.current.createDefaultSession()
    })

    expect(mocks.updateAgent).not.toHaveBeenCalled()
    expect(mocks.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1', model: 'provider:grok-4.5' }),
      { showSuccessToast: false }
    )
  })

  it('reuses an empty session with an unsent draft instead of creating another unnamed session', async () => {
    mocks.sessions = [makeSession({ model: 'provider:gpt-5.6-luna', configuration: { reasoning_effort: 'medium' } })]
    CacheService.set(getAgentSessionDraftCacheKey('agent-1', 'session-1'), 'unfinished request', 60_000)
    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

    await act(async () => {
      await result.current.createDefaultSession()
    })

    expect(mocks.fetchMessages).toHaveBeenCalled()
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.setActiveSessionIdAction).toHaveBeenCalledWith({ agentId: 'agent-1', sessionId: 'session-1' })
  })

  it('creates only one session when new conversation is triggered concurrently', async () => {
    mocks.sessions = []
    mocks.createSession.mockImplementation(async (form) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return makeSession({ ...form, id: 'session-2' })
    })
    const { result } = renderHook(() => useCreateDefaultSession('agent-1'))

    await act(async () => {
      await Promise.all([result.current.createDefaultSession(), result.current.createDefaultSession()])
    })

    expect(mocks.createSession).toHaveBeenCalledTimes(1)
  })
})
