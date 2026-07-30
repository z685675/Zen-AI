import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
