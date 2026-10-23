import { EventEmitter } from 'node:events'

import { createStreamAbortController } from '@main/apiServer/utils/createStreamAbortController'
import { LEGACY_ASSISTANT_READ_ONLY_CODE } from '@shared/agents/assistantAvailability'
import { AgentTaskLimitError } from '@shared/agents/taskConcurrency'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { broadcastAgentActionRequiredMock } = vi.hoisted(() => ({
  broadcastAgentActionRequiredMock: vi.fn()
}))

vi.mock('../agentIpc', () => ({
  broadcastAgentActionRequired: broadcastAgentActionRequiredMock
}))

import type { AgentStream } from '../../interfaces/AgentStreamInterface'

const { invokeMock, resolveAgentRuntimeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  resolveAgentRuntimeMock: vi.fn()
}))

const { getEnableDeveloperModeMock } = vi.hoisted(() => ({ getEnableDeveloperModeMock: vi.fn(() => false) }))
vi.mock('@main/services/ConfigManager', () => ({
  configManager: { getEnableDeveloperMode: getEnableDeveloperModeMock }
}))

const { recordMainDiagnosticMock } = vi.hoisted(() => ({ recordMainDiagnosticMock: vi.fn() }))
const { persistExchangeMock } = vi.hoisted(() => ({ persistExchangeMock: vi.fn(async (payload: unknown) => payload) }))
vi.mock('../../database/sessionMessageRepository', () => ({
  agentMessageRepository: { persistExchange: persistExchangeMock }
}))
vi.mock('@main/services/DiagnosticEvidenceService', () => ({
  beginMainDiagnostic: vi.fn(),
  recordMainDiagnostic: recordMainDiagnosticMock
}))

vi.mock('../../BaseService', () => ({
  BaseService: class BaseService {
    async getDatabase() {
      throw new Error('Database access must be mocked')
    }
  }
}))

vi.mock('../runtime/registry', () => ({
  getAgentRuntimeServiceById: vi.fn(() => ({ invoke: invokeMock })),
  resolveAgentRuntime: resolveAgentRuntimeMock
}))

vi.mock('../channels/ChannelManager', () => ({
  channelManager: {}
}))

vi.mock('../ChannelService', () => ({
  channelService: {}
}))

vi.mock('../managedModelRecovery', () => ({
  getManagedRecoveryInventory: async () => ({ models: [], providers: [] }),
  resolveManagedSessionModel: (_slot: string, current: string) => ({ managed: false, selected: current })
}))

import { SessionMessageService } from '../SessionMessageService'

function createAgentStream(): AgentStream {
  return new EventEmitter() as AgentStream
}

function session() {
  return {
    id: 'session-runtime-test',
    agent_id: DEFAULT_OPENCODE_AGENT_ID,
    agent_type: 'claude-code',
    model: 'provider:grok-4.5',
    configuration: { agent_runtime: 'auto' }
  } as any
}

async function consume(stream: ReadableStream<unknown>) {
  const reader = stream.getReader()
  while (true) {
    const result = await reader.read()
    if (result.done) return
  }
}

async function collect(stream: ReadableStream<unknown>) {
  const values: unknown[] = []
  const reader = stream.getReader()
  while (true) {
    const result = await reader.read()
    if (result.done) return values
    values.push(result.value)
  }
}

describe('SessionMessageService runtime stream lifecycle', () => {
  it('persists stable headless identities, native token details, final text and failed tool state', async () => {
    const service = new SessionMessageService()
    await (service as any).persistHeadlessExchange(
      session(),
      'question',
      'answer',
      'native-session',
      undefined,
      'run-123',
      {
        finalText: 'final answer',
        usage: { inputTokens: 130000, outputTokens: 200, inputTokenDetails: { cacheReadTokens: 120000 } },
        tools: [
          { id: 'tool-1', toolName: 'create_file', failed: true, output: { status: 'created', path: 'bad.docx' } }
        ]
      },
      'paused',
      [
        {
          id: 'owned-copy',
          name: 'copy.txt',
          origin_name: 'copy.txt',
          path: '/workspace/inputs/copy.txt',
          size: 5,
          ext: '.txt',
          type: 'text',
          created_at: 'now',
          count: 1
        }
      ]
    )
    const value = persistExchangeMock.mock.calls.at(-1)![0] as any
    expect(value.user.payload.message.id).toBe('run-123:user')
    expect(value.user.payload.blocks).toContainEqual(
      expect.objectContaining({ type: 'file', file: expect.objectContaining({ path: '/workspace/inputs/copy.txt' }) })
    )
    expect(value.assistant.payload.message).toMatchObject({
      id: 'run-123:assistant',
      askId: 'run-123:user',
      status: 'paused',
      usage: { prompt_tokens: 130000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 120000 } }
    })
    expect(value.assistant.payload.blocks.at(-1)).toMatchObject({
      type: 'tool',
      status: 'error',
      metadata: { rawMcpToolResponse: { status: 'error' } }
    })
  })
  it.each([DEFAULT_OPENCODE_AGENT_ID, 'legacy-agent'])(
    'protects native history at service-level deletion for %s',
    async (agentId) => {
      const service = new SessionMessageService()
      const remove = vi.fn(() => ({ where: vi.fn(async () => ({ rowsAffected: 1 })) }))
      const database = {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ agentId }] }) }) }),
        delete: remove
      }
      vi.spyOn(service, 'getDatabase').mockResolvedValue(database as any)
      try {
        if (agentId === DEFAULT_OPENCODE_AGENT_ID) {
          await expect(service.deleteSessionMessage('delete-safety', 1)).rejects.toMatchObject({
            code: 'native_history_required'
          })
          expect(remove).not.toHaveBeenCalled()
        } else {
          expect(await service.deleteSessionMessage('delete-safety', 1)).toBe(true)
          expect(remove).toHaveBeenCalledOnce()
        }
      } finally {
        vi.restoreAllMocks()
      }
    }
  )
  beforeEach(() => {
    vi.useFakeTimers()
    invokeMock.mockReset()
    getEnableDeveloperModeMock.mockReset().mockReturnValue(false)
    resolveAgentRuntimeMock.mockReset()
    broadcastAgentActionRequiredMock.mockReset()
    recordMainDiagnosticMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['startup', 'continuation', 'deep-research'])(
    'delivers a %s timeout without synchronously cancelling its HTTP reader',
    async (phase) => {
      const agentStream = createAgentStream()
      resolveAgentRuntimeMock.mockResolvedValue({
        runtimeId: 'opencode',
        candidates: ['opencode'],
        source: 'workspace'
      })
      invokeMock.mockResolvedValue(agentStream)
      const service = new SessionMessageService()
      const http = createStreamAbortController({ timeoutMs: 0 })
      const result = await service.createSessionMessage(
        session(),
        { content: 'task', ...(phase === 'deep-research' ? { deep_research: true } : {}) } as any,
        http.abortController
      )
      const reader = result.stream.getReader()
      // This is what the SSE route does synchronously on parent abort. Before
      // the fix it consumes the failure as cancellation and returns normal EOF.
      const disconnect = vi.fn((reason) => void reader.cancel(reason))
      http.registerAbortHandler(disconnect)
      const readOutcome = (async () => {
        while (!(await reader.read()).done) {
          /* drain */
        }
      })().catch((error) => error)
      const completionOutcome = result.completion.catch((error) => error)
      if (phase !== 'startup') {
        agentStream.emit('data', { type: 'chunk', chunk: { type: 'text-delta', id: 'text', text: 'partial' } })
      }
      await vi.advanceTimersByTimeAsync(phase === 'startup' ? 45_001 : phase === 'continuation' ? 180_001 : 480_001)
      const name = phase === 'deep-research' ? 'AgentDeepResearchTimeoutError' : 'AgentRuntimeNoOutputTimeoutError'
      expect(disconnect).not.toHaveBeenCalled()
      expect(http.abortController.signal.aborted).toBe(false)
      expect(invokeMock.mock.calls[0][2].signal.reason).toMatchObject({ name })
      await expect(readOutcome).resolves.toMatchObject({ name })
      await expect(completionOutcome).resolves.toMatchObject({ name })
      http.dispose()
    }
  )

  it.each(['event', 'chunk', 'failed-finish'])(
    'rejects terminal %s errors even with observed tools and a queued complete',
    async (kind) => {
      const agentStream = createAgentStream()
      resolveAgentRuntimeMock.mockResolvedValue({
        runtimeId: 'opencode',
        candidates: ['opencode'],
        source: 'workspace'
      })
      invokeMock.mockResolvedValue(agentStream)
      const result = await new SessionMessageService().createSessionMessage(
        session(),
        { content: 'task' } as any,
        new AbortController()
      )
      const readOutcome = consume(result.stream).catch((error) => error)
      const completionOutcome = result.completion.catch((error) => error)
      const error = Object.assign(new Error('socket closed Bearer fixture-secret'), {
        name: 'ProviderHeaderTimeoutError',
        code: 'ECONNRESET',
        cause: { message: 'native timeout', apiKey: 'fixture-secret' },
        zenFailureStage: 'provider-stream'
      })
      agentStream.emit('data', {
        type: 'chunk',
        chunk: { type: 'tool-call', toolName: 'read', toolCallId: 'tool', input: {} }
      })
      agentStream.emit(
        'data',
        kind === 'event'
          ? { type: 'error', error }
          : {
              type: 'chunk',
              chunk: kind === 'chunk' ? { type: 'error', error } : { type: 'finish', finishReason: 'error' }
            }
      )
      agentStream.emit('data', { type: 'complete' })
      await vi.advanceTimersByTimeAsync(0)
      if (kind === 'failed-finish') {
        await expect(readOutcome).resolves.toMatchObject({ message: 'Agent runtime reported a failed response' })
        await expect(completionOutcome).resolves.toMatchObject({ message: 'Agent runtime reported a failed response' })
      } else {
        expect(await readOutcome).toBe(error)
        const serialized = await completionOutcome
        expect(serialized).toMatchObject({ name: error.name, code: error.code, zenFailureStage: 'provider-stream' })
        expect(JSON.stringify(serialized)).not.toContain('fixture-secret')
      }
      expect(invokeMock).toHaveBeenCalledOnce()
    }
  )

  it('emits an abort part for explicit runtime cancellation rather than a bare EOF', async () => {
    const agentStream = createAgentStream()
    resolveAgentRuntimeMock.mockResolvedValue({ runtimeId: 'opencode', candidates: ['opencode'], source: 'workspace' })
    invokeMock.mockResolvedValue(agentStream)
    const result = await new SessionMessageService().createSessionMessage(
      session(),
      { content: 'task' } as any,
      new AbortController()
    )
    const chunks = collect(result.stream)
    agentStream.emit('data', { type: 'cancelled' })
    await expect(chunks).resolves.toEqual([{ type: 'abort' }])
    await expect(result.completion).resolves.toEqual({})
  })

  it.each([false, true])('rejects deprecated assistant execution before startup (developer=%s)', async (developer) => {
    getEnableDeveloperModeMock.mockReturnValue(developer)
    const service = new SessionMessageService()
    const start = vi.spyOn(service as any, 'startSessionMessageStream')
    await expect(
      service.createSessionMessage(
        { ...session(), agent_id: 'legacy-agent', configuration: { agent_runtime: 'opencode' } },
        { content: 'hello' } as any,
        new AbortController()
      )
    ).rejects.toMatchObject({ code: LEGACY_ASSISTANT_READ_ONLY_CODE })
    expect(start).not.toHaveBeenCalled()
    expect(resolveAgentRuntimeMock).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(getEnableDeveloperModeMock).not.toHaveBeenCalled()
  })

  it.each(['opencode', 'codex', 'claude-code'])(
    'forwards disconnect cancellation to %s before reader cleanup removes abort listeners',
    async (runtimeId) => {
      let active = false
      const attemptControllers: AbortController[] = []
      resolveAgentRuntimeMock.mockResolvedValue({
        runtimeId,
        candidates: [runtimeId],
        source: 'workspace',
        configuredRuntime: 'auto',
        reason: 'cancellation-test'
      })
      invokeMock.mockImplementation(async (_prompt: string, _session: unknown, controller: AbortController) => {
        if (active) throw new Error('This new assistant session already has an active task')
        active = true
        attemptControllers.push(controller)
        controller.signal.addEventListener('abort', () => {
          active = false
        })
        return createAgentStream()
      })
      const service = new SessionMessageService()
      vi.spyOn(service as any, 'getLastAgentSessionId').mockResolvedValue('')
      // The HTTP abort controller registers its listener before the runtime
      // forwarder. Cancelling its reader synchronously must not skip that forwarder.
      const httpStream = createStreamAbortController({ timeoutMs: 0 })
      const result = await service.createSessionMessage(
        session(),
        { content: 'long task' } as any,
        httpStream.abortController
      )
      const reader = result.stream.getReader()
      httpStream.registerAbortHandler((reason) => {
        void reader.cancel(reason)
      })
      httpStream.abortController.abort('Client disconnected')

      expect(attemptControllers[0].signal.aborted).toBe(true)
      expect(attemptControllers[0].signal.reason).toBe('Client disconnected')
      expect(active).toBe(false)
      await expect(result.completion).resolves.toEqual({})
      httpStream.dispose()

      const nextController = new AbortController()
      const next = await service.createSessionMessage(session(), { content: 'continue' } as any, nextController)
      expect(attemptControllers).toHaveLength(2)
      expect(attemptControllers[1].signal.aborted).toBe(false)
      await next.stream.cancel('test finished')
      await expect(next.completion).resolves.toEqual({})
      expect(active).toBe(false)
    }
  )

  it('records a preparation failure if runtime resolution throws before any SDK starts', async () => {
    resolveAgentRuntimeMock.mockRejectedValue(new Error('invalid runtime configuration'))
    const service = new SessionMessageService()
    await expect(
      service.createSessionMessage(session(), { content: 'hello' } as any, new AbortController(), {
        diagnosticId: 'runtime-resolution-test'
      })
    ).rejects.toThrow('invalid runtime configuration')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(recordMainDiagnosticMock).toHaveBeenCalledWith(
      'runtime-resolution-test',
      'preparation',
      'failed',
      expect.objectContaining({ phase: 'runtime-resolution' })
    )
  })

  it('retries the next Auto candidate when the first runtime never starts', async () => {
    const firstStream = createAgentStream()
    const fallbackStream = createAgentStream()
    const attemptControllers: AbortController[] = []

    resolveAgentRuntimeMock.mockResolvedValue({
      runtimeId: 'claude-code',
      candidates: ['claude-code', 'codex'],
      configuredRuntime: 'auto',
      source: 'auto',
      reason: 'test'
    })
    invokeMock.mockImplementation(async (_prompt: string, _session: unknown, attemptController: AbortController) => {
      attemptControllers.push(attemptController)
      return attemptControllers.length === 1 ? firstStream : fallbackStream
    })

    const service = new SessionMessageService()
    vi.spyOn(service as any, 'getLastAgentSessionId').mockResolvedValue('')
    const result = await service.createSessionMessage(
      session(),
      { content: 'create a file' } as any,
      new AbortController()
    )
    const consumed = consume(result.stream)

    await vi.advanceTimersByTimeAsync(45_000)

    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(attemptControllers[0].signal.aborted).toBe(true)
    expect(attemptControllers[1].signal.aborted).toBe(false)

    fallbackStream.emit('data', { type: 'chunk', chunk: { type: 'text-delta', id: 'text-1', text: 'done' } })
    fallbackStream.emit('data', { type: 'complete' })

    await expect(consumed).resolves.toBeUndefined()
    await expect(result.completion).resolves.toEqual({})
  })

  it('keeps a started runtime alive while it is preparing its first visible result', async () => {
    const agentStream = createAgentStream()
    const attemptControllers: AbortController[] = []

    resolveAgentRuntimeMock.mockResolvedValue({
      runtimeId: 'claude-code',
      candidates: ['claude-code'],
      configuredRuntime: 'auto',
      source: 'auto',
      reason: 'test'
    })
    invokeMock.mockImplementation(async (_prompt: string, _session: unknown, attemptController: AbortController) => {
      attemptControllers.push(attemptController)
      return agentStream
    })

    const service = new SessionMessageService()
    vi.spyOn(service as any, 'getLastAgentSessionId').mockResolvedValue('')
    const result = await service.createSessionMessage(
      session(),
      { content: 'create a file' } as any,
      new AbortController()
    )
    const consumed = consume(result.stream)

    agentStream.emit('data', { type: 'chunk', chunk: { type: 'raw', rawValue: { type: 'init' } } })
    await vi.advanceTimersByTimeAsync(45_000)

    expect(attemptControllers[0].signal.aborted).toBe(false)

    agentStream.emit('data', { type: 'chunk', chunk: { type: 'text-delta', id: 'text-1', text: 'done' } })
    agentStream.emit('data', { type: 'complete' })

    await expect(consumed).resolves.toBeUndefined()
    await expect(result.completion).resolves.toEqual({})
  })

  it('pauses the deep research budget while waiting for browser handoff', async () => {
    const agentStream = createAgentStream()
    const attemptControllers: AbortController[] = []

    resolveAgentRuntimeMock.mockResolvedValue({
      runtimeId: 'claude-code',
      candidates: ['claude-code'],
      configuredRuntime: 'auto',
      source: 'auto',
      reason: 'test'
    })
    invokeMock.mockImplementation(async (_prompt: string, _session: unknown, attemptController: AbortController) => {
      attemptControllers.push(attemptController)
      return agentStream
    })

    const service = new SessionMessageService()
    vi.spyOn(service as any, 'getLastAgentSessionId').mockResolvedValue('')
    const result = await service.createSessionMessage(
      session(),
      { content: 'research with login', deep_research: true } as any,
      new AbortController()
    )
    const consumed = consume(result.stream)
    const consumedOutcome = consumed.then(
      () => undefined,
      (error) => error
    )
    const completionOutcome = result.completion.then(
      () => undefined,
      (error) => error
    )

    agentStream.emit('data', { type: 'chunk', chunk: { type: 'raw', rawValue: { type: 'init' } } })
    agentStream.emit('data', { type: 'chunk', chunk: { type: 'text-delta', id: 'text-1', text: 'plan' } })
    await vi.advanceTimersByTimeAsync(7 * 60 * 1000)

    agentStream.emit('data', {
      type: 'chunk',
      chunk: {
        type: 'tool-call',
        toolCallId: 'handoff-1',
        toolName: 'mcp__browser__wait_for_user',
        input: { message: '请完成登录后点击继续。', reason: 'login_required' }
      }
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(broadcastAgentActionRequiredMock).toHaveBeenCalledWith({
      requestId: 'handoff-1',
      agentId: DEFAULT_OPENCODE_AGENT_ID,
      sessionId: 'session-runtime-test',
      reason: 'browser_handoff',
      message: '请完成登录后点击继续。'
    })
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(attemptControllers[0].signal.aborted).toBe(false)

    agentStream.emit('data', {
      type: 'chunk',
      chunk: {
        type: 'tool-result',
        toolCallId: 'handoff-1',
        toolName: 'mcp__browser__wait_for_user',
        output: { status: 'continued' }
      }
    })
    await vi.advanceTimersByTimeAsync(60_001)

    expect(attemptControllers[0].signal.aborted).toBe(true)
    await expect(consumedOutcome).resolves.toMatchObject({
      message: '深度研究已达到 8 分钟安全时限。已保留已完成的证据，请缩小研究范围后重试。'
    })
    await expect(completionOutcome).resolves.toMatchObject({
      message: '深度研究已达到 8 分钟安全时限。已保留已完成的证据，请缩小研究范围后重试。'
    })
  })

  it('rebuilds a stale runtime session once from the local recovery context', async () => {
    const staleStream = createAgentStream()
    const recoveredStream = createAgentStream()
    const attemptControllers: AbortController[] = []

    resolveAgentRuntimeMock.mockResolvedValue({
      runtimeId: 'codex',
      candidates: ['codex', 'claude-code'],
      configuredRuntime: 'auto',
      source: 'auto',
      reason: 'test'
    })
    invokeMock.mockImplementation(async (_prompt: string, _session: unknown, attemptController: AbortController) => {
      attemptControllers.push(attemptController)
      return attemptControllers.length === 1 ? staleStream : recoveredStream
    })

    const service = new SessionMessageService()
    vi.spyOn(service as any, 'getLastAgentSessionId').mockResolvedValue('stale-thread')
    const result = await service.createSessionMessage(
      session(),
      {
        content: 'continue the task',
        recovery_context: 'Earlier verified checkpoint'
      } as any,
      new AbortController()
    )
    const consumed = consume(result.stream)

    staleStream.emit('data', {
      type: 'error',
      error: new Error('thread/resume failed: no rollout found for thread id stale-thread')
    })
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))

    expect(attemptControllers[0].signal.aborted).toBe(true)
    expect(invokeMock.mock.calls[1][0]).toContain('Earlier verified checkpoint')
    expect(invokeMock.mock.calls[1][3]).toBeUndefined()

    recoveredStream.emit('data', { type: 'chunk', chunk: { type: 'text-delta', id: 'text-1', text: 'done' } })
    recoveredStream.emit('data', { type: 'complete' })

    await expect(consumed).resolves.toBeUndefined()
    await expect(result.completion).resolves.toEqual({})
  })

  it('restarts a stream from a checkpoint after a transient channel failure', async () => {
    const interruptedStream = createAgentStream()
    const recoveredStream = createAgentStream()
    const attemptControllers: AbortController[] = []

    resolveAgentRuntimeMock.mockResolvedValue({
      runtimeId: 'claude-code',
      candidates: ['claude-code'],
      configuredRuntime: 'auto',
      source: 'auto',
      reason: 'test'
    })
    invokeMock.mockImplementation(async (_prompt: string, _session: unknown, attemptController: AbortController) => {
      attemptControllers.push(attemptController)
      return attemptControllers.length === 1 ? interruptedStream : recoveredStream
    })

    const service = new SessionMessageService()
    vi.spyOn(service as any, 'getLastAgentSessionId').mockResolvedValue('active-thread')
    const result = await service.createSessionMessage(
      session(),
      { content: 'finish the project safely' } as any,
      new AbortController()
    )
    const collected = collect(result.stream)

    interruptedStream.emit('data', {
      type: 'chunk',
      chunk: { type: 'text-delta', id: 'text-1', text: '已完成第一步，' }
    })
    interruptedStream.emit('data', {
      type: 'chunk',
      chunk: {
        type: 'tool-call',
        toolCallId: 'write-1',
        toolName: 'mcp__assistant__create_file',
        input: { path: 'README.md' }
      }
    })
    interruptedStream.emit('data', {
      type: 'chunk',
      chunk: { type: 'tool-result', toolCallId: 'write-1', toolName: 'mcp__assistant__create_file', output: 'created' }
    })
    interruptedStream.emit('data', { type: 'error', error: new Error('Failed to fetch') })

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))

    expect(attemptControllers[0].signal.aborted).toBe(true)
    expect(attemptControllers[1].signal.aborted).toBe(false)
    expect(invokeMock.mock.calls[1][0]).toContain('Safe Agent Stream Recovery Checkpoint')
    expect(invokeMock.mock.calls[1][0]).toContain('mcp__assistant__create_file')
    expect(invokeMock.mock.calls[1][3]).toBeUndefined()

    recoveredStream.emit('data', { type: 'chunk', chunk: { type: 'raw', rawValue: { type: 'init' } } })
    recoveredStream.emit('data', {
      type: 'chunk',
      chunk: { type: 'text-delta', id: 'text-2', text: '正在验证剩余步骤。' }
    })
    recoveredStream.emit('data', { type: 'complete' })

    const chunks = await collected
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'raw', rawValue: expect.objectContaining({ type: 'agent_stream_recovery' }) })
      ])
    )
    await expect(result.completion).resolves.toEqual({})
  })

  it('rejects an empty completion instead of persisting a blank assistant response', async () => {
    const agentStream = createAgentStream()

    resolveAgentRuntimeMock.mockResolvedValue({
      runtimeId: 'claude-code',
      candidates: ['claude-code'],
      configuredRuntime: 'auto',
      source: 'auto',
      reason: 'test'
    })
    invokeMock.mockResolvedValue(agentStream)

    const service = new SessionMessageService()
    vi.spyOn(service as any, 'getLastAgentSessionId').mockResolvedValue('')
    const result = await service.createSessionMessage(
      session(),
      { content: 'create a file' } as any,
      new AbortController()
    )
    const consumed = consume(result.stream)

    agentStream.emit('data', { type: 'chunk', chunk: { type: 'start-step' } })
    agentStream.emit('data', { type: 'chunk', chunk: { type: 'text-start', id: 'empty-text' } })
    agentStream.emit('data', { type: 'chunk', chunk: { type: 'text-delta', id: 'empty-text', text: '  ' } })
    agentStream.emit('data', { type: 'chunk', chunk: { type: 'text-end', id: 'empty-text' } })
    agentStream.emit('data', { type: 'chunk', chunk: { type: 'finish', finishReason: 'stop' } })
    agentStream.emit('data', { type: 'complete' })

    await expect(consumed).rejects.toThrow('completed before producing a user-visible result')
    await expect(result.completion).rejects.toMatchObject({
      message: 'Agent runtime completed before producing a user-visible result'
    })
  })

  it('does not let empty text blocks disable the first-output watchdog', async () => {
    const agentStream = createAgentStream()
    resolveAgentRuntimeMock.mockResolvedValue({ runtimeId: 'claude-code', candidates: ['claude-code'], source: 'auto' })
    invokeMock.mockResolvedValue(agentStream)
    const service = new SessionMessageService()
    vi.spyOn(service as any, 'getLastAgentSessionId').mockResolvedValue('')
    const result = await service.createSessionMessage(session(), { content: 'research' } as any, new AbortController())
    const streamOutcome = consume(result.stream).catch((error) => error)
    const completionOutcome = result.completion.catch((error) => error)
    agentStream.emit('data', { type: 'chunk', chunk: { type: 'text-start', id: 'empty' } })
    await vi.advanceTimersByTimeAsync(180_001)
    await expect(streamOutcome).resolves.toMatchObject({ name: 'AgentRuntimeNoOutputTimeoutError' })
    await expect(completionOutcome).resolves.toMatchObject({ name: 'AgentRuntimeNoOutputTimeoutError' })
  })

  it('recovers a 503 before output once and discards the failed stream finish queued in the same tick', async () => {
    const failed = createAgentStream()
    const recovered = createAgentStream()
    resolveAgentRuntimeMock.mockResolvedValue({ runtimeId: 'claude-code', candidates: ['claude-code'], source: 'auto' })
    invokeMock.mockResolvedValueOnce(failed).mockResolvedValueOnce(recovered)
    const service = new SessionMessageService()
    vi.spyOn(service as any, 'getLastAgentSessionId').mockResolvedValue('')
    const result = await service.createSessionMessage(session(), { content: 'research' } as any, new AbortController())
    const collected = collect(result.stream)
    failed.emit('data', { type: 'chunk', chunk: { type: 'error', error: new Error('503 Service Unavailable') } })
    failed.emit('data', { type: 'chunk', chunk: { type: 'text-delta', id: 'stale', text: 'stale reply' } })
    failed.emit('data', { type: 'complete' })
    await vi.advanceTimersByTimeAsync(0)
    expect(invokeMock).toHaveBeenCalledTimes(2)
    recovered.emit('data', { type: 'chunk', chunk: { type: 'text-delta', id: 'new', text: 'Recovered answer' } })
    recovered.emit('data', { type: 'complete' })
    const chunks = await collected
    expect(chunks).not.toContainEqual(expect.objectContaining({ text: 'stale reply' }))
    expect(chunks).toContainEqual(expect.objectContaining({ text: 'Recovered answer' }))
    await expect(result.completion).resolves.toEqual({})
  })

  it('stops after the recovery also receives a 503 instead of retrying indefinitely', async () => {
    const failed = createAgentStream()
    const recovered = createAgentStream()
    resolveAgentRuntimeMock.mockResolvedValue({ runtimeId: 'claude-code', candidates: ['claude-code'], source: 'auto' })
    invokeMock.mockResolvedValueOnce(failed).mockResolvedValueOnce(recovered)
    const service = new SessionMessageService()
    vi.spyOn(service as any, 'getLastAgentSessionId').mockResolvedValue('')
    const result = await service.createSessionMessage(session(), { content: 'research' } as any, new AbortController())
    const streamOutcome = consume(result.stream).catch((error) => error)
    const completionOutcome = result.completion.catch((error) => error)
    failed.emit('data', { type: 'error', error: new Error('503 Service Unavailable') })
    await vi.advanceTimersByTimeAsync(0)
    recovered.emit('data', { type: 'error', error: new Error('503 Service Unavailable') })
    await expect(streamOutcome).resolves.toMatchObject({ message: '503 Service Unavailable' })
    await expect(completionOutcome).resolves.toMatchObject({ message: '503 Service Unavailable' })
    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(invokeMock.mock.calls[0][2].signal.aborted).toBe(true)
    expect(invokeMock.mock.calls[1][2].signal.aborted).toBe(true)
  })

  it('guards the next inference after tools finish without timing out a tool or user handoff', async () => {
    const stalled = createAgentStream()
    const recovered = createAgentStream()
    resolveAgentRuntimeMock.mockResolvedValue({
      runtimeId: 'codex',
      candidates: ['codex', 'claude-code'],
      source: 'auto'
    })
    invokeMock.mockResolvedValueOnce(stalled).mockResolvedValueOnce(recovered)
    const service = new SessionMessageService()
    vi.spyOn(service as any, 'getLastAgentSessionId').mockResolvedValue('')
    const result = await service.createSessionMessage(
      session(),
      { content: 'read the spreadsheet' } as any,
      new AbortController()
    )
    const collected = collect(result.stream)
    stalled.emit('data', {
      type: 'chunk',
      chunk: { type: 'tool-call', toolCallId: 'read-1', toolName: 'Read', input: { path: 'report.xlsx' } }
    })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls[0][2].signal.aborted).toBe(false)
    stalled.emit('data', {
      type: 'chunk',
      chunk: { type: 'tool-result', toolCallId: 'read-1', toolName: 'Read', output: '12 rows' }
    })
    await vi.advanceTimersByTimeAsync(180_001)
    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(invokeMock.mock.calls[0][2].signal.aborted).toBe(true)
    expect(invokeMock.mock.calls[1][0]).toContain('12 rows')
    recovered.emit('data', { type: 'chunk', chunk: { type: 'text-delta', id: 'answer', text: '表格共有 12 行。' } })
    recovered.emit('data', { type: 'complete' })
    await expect(result.completion).resolves.toEqual({})
    const chunks = await collected
    expect(chunks).toContainEqual(expect.objectContaining({ text: '表格共有 12 行。' }))
    await vi.advanceTimersByTimeAsync(600_000)
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })
})

describe('SessionMessageService shared task admission', () => {
  beforeEach(() => getEnableDeveloperModeMock.mockReturnValue(false))

  function pendingTask(service: SessionMessageService) {
    let finish!: () => void
    let fail!: (error: Error) => void
    const completion = new Promise<{}>((resolve, reject) => {
      finish = () => resolve({})
      fail = reject
    })
    const result = { stream: new ReadableStream(), completion }
    const start = vi.spyOn(service as any, 'startSessionMessageStream').mockResolvedValue(result)
    return { finish, fail, result, start }
  }

  it('reserves before asynchronous preparation across service instances and new assistant sessions', async () => {
    const firstService = new SessionMessageService()
    const secondService = new SessionMessageService()
    const first = pendingTask(firstService)
    const second = pendingTask(secondService)
    let resolveStartup!: (value: typeof first.result) => void
    first.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStartup = resolve
        })
    )
    const started = firstService.createSessionMessage(
      { ...session(), id: 'admission-new', configuration: { agent_runtime: 'opencode' } },
      { content: 'task' } as any,
      new AbortController()
    )
    try {
      await expect(
        secondService.createSessionMessage(
          { ...session(), id: 'admission-old' },
          { content: 'task' } as any,
          new AbortController()
        )
      ).rejects.toThrow(AgentTaskLimitError)
      expect(second.start).not.toHaveBeenCalled()
    } finally {
      resolveStartup(first.result)
      const running = await started
      first.finish()
      await running.completion
    }
    const next = await secondService.createSessionMessage(
      { ...session(), id: 'admission-old' },
      { content: 'task' } as any,
      new AbortController()
    )
    second.finish()
    await next.completion
  })

  it('reads developer mode from main-process configuration and enforces the new limit after it changes', async () => {
    getEnableDeveloperModeMock.mockReturnValue(true)
    const services = Array.from({ length: 4 }, () => new SessionMessageService())
    const pending = services.map(pendingTask)
    const running = [] as Array<{ completion: Promise<unknown> }>
    const send = (index: number) =>
      services[index].createSessionMessage(
        { ...session(), id: `admission-dev-${index}` },
        { content: 'task' } as any,
        new AbortController()
      )
    try {
      for (let i = 0; i < 3; i++) running.push(await send(i))
      await expect(send(3)).rejects.toThrow(AgentTaskLimitError)
      expect(pending[3].start).not.toHaveBeenCalled()
      getEnableDeveloperModeMock.mockReturnValue(false)
      pending[0].finish()
      pending[1].finish()
      await Promise.all(running.slice(0, 2).map((result) => result.completion))
      await expect(send(3)).rejects.toThrow(AgentTaskLimitError)
      pending[2].finish()
      await running[2].completion
      running.push(await send(3))
    } finally {
      pending.forEach((task) => task.finish())
      await Promise.all(running.map((result) => result.completion))
    }
  })

  it('releases after completion rejection and startup failure and skips already-cancelled requests', async () => {
    const service = new SessionMessageService()
    const first = pendingTask(service)
    const send = (controller = new AbortController()) =>
      service.createSessionMessage({ ...session(), id: 'admission-failure' }, { content: 'task' } as any, controller)
    const running = await send()
    first.fail(new Error('upstream failed'))
    await expect(running.completion).rejects.toThrow('upstream failed')
    first.start.mockRejectedValueOnce(new Error('startup failed'))
    await expect(send()).rejects.toThrow('startup failed')
    const cancelled = new AbortController()
    cancelled.abort()
    const calls = first.start.mock.calls.length
    await expect(send(cancelled)).rejects.toThrow()
    expect(first.start).toHaveBeenCalledTimes(calls)
    first.start.mockResolvedValueOnce({ stream: new ReadableStream(), completion: Promise.resolve({}) })
    await (await send()).completion
  })
})
