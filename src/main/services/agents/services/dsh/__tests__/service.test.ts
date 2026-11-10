import { EventEmitter } from 'node:events'

import type { GetAgentSessionResponse } from '@types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  status: vi.fn(),
  validate: vi.fn(),
  get: vi.fn(),
  stop: vi.fn(),
  prepare: vi.fn(),
  dispose: vi.fn(),
  finish: vi.fn(),
  approve: vi.fn()
}))
vi.mock('../../../../dshPreview/access', () => ({ assertDshPreviewUnlocked: mocks.gate }))
vi.mock('../../../../dshPreview/runtime', () => ({
  getDshPreviewRuntimeStatus: mocks.status,
  getDshRuntime: mocks.get,
  stopDshSession: mocks.stop
}))
vi.mock('@main/apiServer/utils', () => ({ validateModelId: mocks.validate }))
vi.mock('@main/apiServer/routes/assistant-mcp', () => ({ touchAssistantMcpContext: vi.fn() }))
vi.mock('@main/apiServer/routes/browser-mcp', () => ({ touchBrowserMcpContext: vi.fn() }))
vi.mock('@main/services/DiagnosticEvidenceService', () => ({ recordMainDiagnostic: vi.fn() }))
vi.mock('../../claudecode/tool-permissions', () => ({ promptForToolApproval: mocks.approve }))
vi.mock('../config', () => ({ prepareDshConfig: mocks.prepare }))

import DshService from '../index'

const session = {
  id: 'test-dsh-session',
  model: 'provider:model',
  accessible_paths: ['/workspace']
} as GetAgentSessionResponse
const tick = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.gate.mockImplementation(() => undefined)
  mocks.status.mockReturnValue({ state: 'ready' })
  mocks.validate.mockResolvedValue({ valid: true, provider: {}, modelId: 'model' })
  mocks.finish.mockResolvedValue(undefined)
  mocks.prepare.mockResolvedValue({ config: {}, dispose: mocks.dispose, finishTurn: mocks.finish })
  mocks.stop.mockResolvedValue(undefined)
})

function nativeRuntime() {
  const runtime = Object.assign(new EventEmitter(), {
    nativeId: 'zen-native',
    call: vi.fn(async () => ({ messageId: 'initial-user' })),
    snapshot: () => ({ sessionId: 'zen-native', events: [] }),
    wait: vi.fn(async () => {
      runtime.emit('event', {
        method: 'session.event',
        params: {
          sessionId: 'zen-native',
          event: { type: 'user/message', seq: 0, data: { id: 'steer-user', source: { kind: 'user' } } }
        }
      })
      runtime.emit('event', {
        method: 'session.event',
        params: {
          sessionId: 'zen-native',
          event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }
        }
      })
    }),
    answer: vi.fn()
  })
  mocks.get.mockResolvedValue(runtime)
  return runtime
}

describe('DSH service lifecycle', () => {
  it('imports and constructs without startup, and rejects unprepared use without downloading', async () => {
    const service = new DshService()
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    mocks.status.mockReturnValue({ state: 'not-installed' })
    const stream = await service.invoke('hello', session, new AbortController())
    const events: any[] = []
    stream.on('data', (event) => events.push(event))
    await tick()
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('keeps the lease until its own runtime is stopped and binds only the initial prompt id', async () => {
    const runtime = nativeRuntime()
    let release!: () => void
    mocks.stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const stream = await new DshService().invoke('hello', session, new AbortController())
    const events: any[] = []
    stream.on('data', (event) => events.push(event))
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledWith(session.id, runtime))
    expect(events.some((event) => event.type === 'complete')).toBe(false)
    expect(mocks.dispose).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('complete'))
    expect(mocks.dispose).toHaveBeenCalledOnce()
    expect(mocks.finish).toHaveBeenCalledOnce()
    expect(
      events
        .filter((event) => event.chunk?.rawValue?.type === 'dsh_turn')
        .map((event) => event.chunk.rawValue.user_message_id)
    ).toEqual(['initial-user'])
  })

  it('cancels the same native agent and waits for cleanup before cancelled', async () => {
    const runtime = nativeRuntime()
    const controller = new AbortController()
    let finish!: () => void
    runtime.wait.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    let stopped!: () => void
    mocks.stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          stopped = resolve
        })
    )
    const stream = await new DshService().invoke('hello', session, controller)
    const events: any[] = []
    stream.on('data', (event) => events.push(event))
    await vi.waitFor(() => expect(runtime.wait).toHaveBeenCalled())
    controller.abort()
    finish()
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled())
    expect(runtime.call).toHaveBeenCalledWith('session/cancel')
    expect(events.some((event) => event.type === 'cancelled')).toBe(false)
    stopped()
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('cancelled'))
    expect(mocks.get).toHaveBeenCalledOnce()
  })

  it('routes child approval through the root Zen session with its actual child arguments', async () => {
    const runtime = nativeRuntime()
    mocks.approve.mockResolvedValue({ behavior: 'deny' })
    runtime.wait.mockImplementation(async () => {
      runtime.emit('event', {
        id: 'host-child',
        method: 'approval/request',
        params: {
          sessionId: 'native-child',
          callId: 'child-write',
          toolName: 'write',
          toolInput: { file_path: '/outside/original.txt', content: 'child content' }
        }
      })
      await vi.waitFor(() => expect(runtime.answer).toHaveBeenCalledWith('host-child', { outcome: 'rejected' }))
      runtime.emit('event', {
        method: 'session.event',
        params: {
          sessionId: 'zen-native',
          event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } }
        }
      })
    })
    const stream = await new DshService().invoke('delegate', session, new AbortController())
    const events: any[] = []
    stream.on('data', (event) => events.push(event))
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('complete'))
    expect(mocks.approve).toHaveBeenCalledWith(
      'write',
      { file_path: '/outside/original.txt', content: 'child content', nativeChildSessionId: 'native-child' },
      expect.objectContaining({ toolCallId: `${session.id}:native-child:child-write` })
    )
  })
})
