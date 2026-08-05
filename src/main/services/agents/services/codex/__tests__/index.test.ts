import type { GetAgentSessionResponse } from '@types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const codexSdkMocks = vi.hoisted(() => ({
  startThread: vi.fn(),
  resumeThread: vi.fn()
}))

const assistantMcpMocks = vi.hoisted(() => ({
  register: vi.fn(),
  cleanup: vi.fn()
}))

const browserMcpMocks = vi.hoisted(() => ({
  register: vi.fn(),
  cleanup: vi.fn()
}))

const runtimeMocks = vi.hoisted(() => ({
  getApiConfig: vi.fn(),
  getPythonEnvironment: vi.fn()
}))

vi.mock('@openai/codex-sdk', () => ({
  Codex: vi.fn(() => ({
    startThread: codexSdkMocks.startThread,
    resumeThread: codexSdkMocks.resumeThread
  }))
}))

vi.mock('@main/apiServer/config', () => ({
  config: {
    get: runtimeMocks.getApiConfig
  }
}))

vi.mock('@main/apiServer/routes/assistant-mcp', () => ({
  registerAssistantMcpContext: assistantMcpMocks.register,
  cleanupAssistantMcpContext: assistantMcpMocks.cleanup
}))

vi.mock('@main/apiServer/routes/browser-mcp', () => ({
  registerBrowserMcpContext: browserMcpMocks.register,
  cleanupBrowserMcpContext: browserMcpMocks.cleanup
}))

vi.mock('@main/apiServer/utils', () => ({
  validateModelId: vi.fn()
}))

vi.mock('@main/services/proxy/nodeProxy', () => ({
  getProxyEnvironment: vi.fn(() => ({}))
}))

vi.mock('@main/services/python/ManagedPythonService', () => ({
  managedPythonService: {
    getAgentEnvironment: runtimeMocks.getPythonEnvironment
  }
}))

vi.mock('../../builtin/BuiltinAgentProvisioner', () => ({
  ensureBuiltinAgentRuntimeSkillRoots: vi.fn(),
  isProvisioned: vi.fn(() => true),
  provisionBuiltinAgent: vi.fn()
}))

vi.mock('../../runtime/features', () => ({
  getCodexRuntimeDisabledError: vi.fn(
    () => new Error('Codex runtime is disabled in this build. Switch Agent runtime to Auto or Claude Code.')
  ),
  isCodexRuntimeEnabled: vi.fn()
}))

vi.mock('../executable', () => ({
  resolveCodexExecutable: vi.fn(() => null)
}))

import { validateModelId } from '@main/apiServer/utils'

import { isCodexRuntimeEnabled } from '../../runtime/features'
import CodexService, { isMissingCodexRolloutError } from '../index'

const isCodexRuntimeEnabledMock = vi.mocked(isCodexRuntimeEnabled)
const validateModelIdMock = vi.mocked(validateModelId)

const baseSession = {
  id: 'session-1',
  agent_id: 'agent-1',
  agent_type: 'claude-code',
  name: 'Session',
  accessible_paths: ['C:\\workspace'],
  model: 'openai:gpt-5.1-codex',
  configuration: {
    agent_runtime: 'codex'
  },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z'
} as unknown as GetAgentSessionResponse

function waitForStreamEvent(stream: Awaited<ReturnType<CodexService['invoke']>>) {
  return new Promise<any>((resolve) => {
    stream.once('data', resolve)
  })
}

describe('CodexService startup errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isCodexRuntimeEnabledMock.mockReturnValue(true)
    runtimeMocks.getPythonEnvironment.mockResolvedValue({})
  })

  it('emits a single observable error when the feature flag is disabled', async () => {
    isCodexRuntimeEnabledMock.mockReturnValue(false)
    const service = new CodexService()
    const stream = await service.invoke('hello', baseSession, new AbortController())
    const listener = vi.fn()
    stream.on('data', listener)

    const event = await waitForStreamEvent(stream)

    expect(event.type).toBe('error')
    expect(event.error.message).toContain('Codex runtime is disabled')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(validateModelIdMock).not.toHaveBeenCalled()
  })

  it('emits invalid model errors after callers can attach listeners', async () => {
    validateModelIdMock.mockResolvedValue({
      valid: false,
      error: {
        type: 'model_not_available',
        message: 'missing',
        code: 'model_not_available'
      }
    })
    const service = new CodexService()
    const stream = await service.invoke('hello', baseSession, new AbortController())

    const event = await waitForStreamEvent(stream)

    expect(event.type).toBe('error')
    expect(event.error.message).toContain('Invalid model ID')
  })

  it('recognizes missing local rollout errors without treating unrelated failures as resume loss', () => {
    expect(
      isMissingCodexRolloutError(
        new Error('thread/resume: thread/resume failed: no rollout found for thread id stale-thread (code -32600)')
      )
    ).toBe(true)
    expect(isMissingCodexRolloutError(new Error('connection reset'))).toBe(false)
  })

  it('surfaces a stale rollout error so the session service can rebuild local continuity once', async () => {
    validateModelIdMock.mockResolvedValue({
      valid: true,
      provider: {
        id: 'openai',
        type: 'openai',
        apiKey: 'test-key',
        apiHost: 'https://example.com/v1',
        models: [{ id: 'gpt-5.1-codex' }]
      },
      modelId: 'gpt-5.1-codex'
    } as any)

    codexSdkMocks.resumeThread.mockReturnValue({
      id: 'stale-thread',
      runStreamed: vi
        .fn()
        .mockRejectedValue(
          new Error('thread/resume: thread/resume failed: no rollout found for thread id stale-thread (code -32600)')
        )
    })
    const service = new CodexService()
    const stream = await service.invoke('hello', baseSession, new AbortController(), 'stale-thread')
    const received: any[] = []
    await new Promise<void>((resolve) => {
      stream.on('data', (event) => {
        received.push(event)
        if (event.type === 'complete' || event.type === 'error') resolve()
      })
    })

    expect(codexSdkMocks.resumeThread).toHaveBeenCalledWith('stale-thread', expect.any(Object))
    expect(codexSdkMocks.startThread).not.toHaveBeenCalled()
    expect(received.at(-1)?.type).toBe('error')
    expect(received.at(-1)?.error?.message).toContain('no rollout found')
  })

  it('releases the built-in Assistant MCP context after a Codex turn completes', async () => {
    validateModelIdMock.mockResolvedValue({
      valid: true,
      provider: {
        id: 'openai',
        type: 'openai',
        apiKey: 'test-key',
        apiHost: 'https://example.com/v1',
        models: [{ id: 'gpt-5.1-codex' }]
      },
      modelId: 'gpt-5.1-codex'
    } as any)
    runtimeMocks.getApiConfig.mockResolvedValue({
      host: '127.0.0.1',
      port: 23333,
      apiKey: 'local-api-key'
    })
    codexSdkMocks.startThread.mockReturnValue({
      id: 'thread-1',
      runStreamed: vi.fn().mockResolvedValue({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'thread-1' }
        })()
      })
    })

    const builtinSession = {
      ...baseSession,
      configuration: { agent_runtime: 'codex', builtin_role: 'fusion' }
    } as GetAgentSessionResponse
    const service = new CodexService()
    const stream = await service.invoke('hello', builtinSession, new AbortController())

    await new Promise<void>((resolve) => {
      stream.on('data', (event) => {
        if (event.type === 'complete' || event.type === 'error') resolve()
      })
    })

    expect(assistantMcpMocks.register).toHaveBeenCalledWith('session-1', ['C:\\workspace'])
    expect(browserMcpMocks.register).toHaveBeenCalledWith('session-1')
    await vi.waitFor(() => expect(assistantMcpMocks.cleanup).toHaveBeenCalledTimes(1))
    expect(assistantMcpMocks.cleanup).toHaveBeenCalledWith('session-1')
    expect(browserMcpMocks.cleanup).toHaveBeenCalledWith('session-1')
  })
})
