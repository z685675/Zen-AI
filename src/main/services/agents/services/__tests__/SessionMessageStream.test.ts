import { EventEmitter } from 'node:events'

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

vi.mock('../../BaseService', () => ({
  BaseService: class BaseService {}
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

import { SessionMessageService } from '../SessionMessageService'

function createAgentStream(): AgentStream {
  return new EventEmitter() as AgentStream
}

function session() {
  return {
    id: 'session-runtime-test',
    agent_id: 'agent-runtime-test',
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

describe('SessionMessageService runtime stream lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    invokeMock.mockReset()
    resolveAgentRuntimeMock.mockReset()
    broadcastAgentActionRequiredMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
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
    expect(broadcastAgentActionRequiredMock).toHaveBeenCalledWith({
      agentId: 'agent-runtime-test',
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

    agentStream.emit('data', { type: 'complete' })

    await expect(consumed).rejects.toThrow('completed before producing a user-visible result')
    await expect(result.completion).rejects.toMatchObject({
      message: 'Agent runtime completed before producing a user-visible result'
    })
  })
})
