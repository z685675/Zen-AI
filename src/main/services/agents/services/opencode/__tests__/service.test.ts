import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getProcess: vi.fn(), permission: vi.fn(), diagnostic: vi.fn() }))
vi.mock('../process', () => ({ getOpenCodeProcess: mocks.getProcess }))
vi.mock('@main/apiServer/routes/assistant-mcp', () => ({ touchAssistantMcpContext: vi.fn() }))
vi.mock('@main/apiServer/routes/browser-mcp', () => ({ touchBrowserMcpContext: vi.fn() }))
vi.mock('@main/apiServer/config', () => ({
  config: { get: vi.fn(async () => ({ host: '127.0.0.1', port: 1, apiKey: 'placeholder' })) }
}))
vi.mock('@main/apiServer/utils', () => ({
  validateModelId: vi.fn(async () => ({
    valid: true,
    modelId: 'gpt-test',
    provider: {
      id: 'local',
      type: 'new-api',
      apiHost: 'http://127.0.0.1/v1',
      apiKey: 'placeholder',
      models: [{ id: 'gpt-test' }]
    }
  }))
}))
vi.mock('@main/services/DiagnosticEvidenceService', () => ({ recordMainDiagnostic: mocks.diagnostic }))
vi.mock('../../../skills/SkillRepository', () => ({
  SkillRepository: { getInstance: () => ({ list: async () => [] }) }
}))
vi.mock('../../claudecode/tool-permissions', () => ({ promptForToolApproval: mocks.permission }))
vi.mock('@main/utils', () => ({ getDataPath: () => '/nonexistent-open-code-test' }))

import type { AgentStreamEvent } from '../../../interfaces/AgentStreamInterface'
import OpenCodeService from '../index'

const fixture = {
  id: 'zen-test',
  agent_id: 'zen-opencode-default',
  agent_type: 'claude-code',
  model: 'local:gpt-test',
  accessible_paths: ['/nonexistent-open-code-test'],
  configuration: {},
  instructions: ''
} as any
let mode: 'success' | 'error' | 'empty' | 'retry' | 'disconnect' | 'permission' | 'permission-wait' | 'browser-wait' =
  'success'
let pause: { ready: () => void; wait: Promise<void> } | undefined
function hold(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cancel = () => reject(signal.reason)
    if (signal.aborted) return cancel()
    signal.addEventListener('abort', cancel, { once: true })
    pause!.wait.then(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, reject)
  })
}
let body: any
let historyReads = 0
let failureMessage = 'upstream unavailable'
let transportError: Record<string, unknown> | undefined
let recoverTransport = false
const nativeInfo = () => ({
  id: 'assistant-new',
  sessionID: 'native',
  role: 'assistant',
  time: { completed: 1 },
  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 50, write: 0 } }
})
const request = vi.fn(async (route: string, _method?: string, data?: unknown) => {
  if (route.endsWith('/prompt_async')) {
    body = data
    runtime.setProgressListener.mock.calls.at(-1)?.[0]?.('request-started', {})
    return
  }
  if (route === '/session/status') return { native: { type: mode === 'retry' ? 'busy' : 'idle' } }
  if (route.endsWith('/message')) {
    historyReads++
    if (historyReads === 1) return [{ info: { id: 'old', role: 'assistant' }, parts: [] }]
    return [
      { info: { id: body.messageID, role: 'user' }, parts: [] },
      {
        info: nativeInfo(),
        parts:
          mode === 'empty'
            ? []
            : [{ id: 'text1', messageID: 'assistant-new', type: 'text', text: '你好', time: { end: 1 } }]
      }
    ]
  }
})
async function* events(signal: AbortSignal) {
  yield { type: 'server.connected', properties: {} }
  yield { type: 'message.updated', properties: { info: { id: body.messageID, sessionID: 'native', role: 'user' } } }
  yield { type: 'session.status', properties: { sessionID: 'native', status: { type: 'busy' } } }
  if (transportError) runtime.setProgressListener.mock.calls.at(-1)?.[0]?.('failed', transportError)
  if (recoverTransport) runtime.setProgressListener.mock.calls.at(-1)?.[0]?.('headers-received', { status: 503 })
  if (mode === 'error') {
    yield {
      type: 'session.error',
      properties: {
        sessionID: 'native',
        error: { name: 'APIError', data: { message: failureMessage, statusCode: 503 } }
      }
    }
    return
  }
  if (mode === 'retry') {
    yield { type: 'session.status', properties: { sessionID: 'native', status: { type: 'retry', attempt: 4 } } }
    return
  }
  if (mode === 'permission' || mode === 'permission-wait') {
    yield {
      type: 'permission.asked',
      properties: { id: 'per1', sessionID: 'native', permission: 'bash', metadata: { command: 'safe preview' } }
    }
    if (mode === 'permission-wait') await hold(signal)
    await new Promise((resolve) => setImmediate(resolve))
  }
  if (mode === 'browser-wait') {
    yield { type: 'message.updated', properties: { info: nativeInfo() } }
    const part = {
      id: 'browser-tool',
      messageID: 'assistant-new',
      sessionID: 'native',
      type: 'tool',
      callID: 'browser-call',
      tool: 'zen_browser_wait_for_user',
      state: { status: 'running', input: {} }
    }
    yield { type: 'message.part.updated', properties: { part } }
    pause!.ready()
    await hold(signal)
    yield {
      type: 'message.part.updated',
      properties: { part: { ...part, state: { status: 'completed', input: {}, output: 'user finished' } } }
    }
  }
  if (mode === 'disconnect') throw new Error('mock EOF')
  yield { type: 'message.updated', properties: { info: nativeInfo() } }
  if (mode !== 'empty')
    yield {
      type: 'message.part.updated',
      properties: {
        sessionID: 'native',
        part: {
          id: 'text1',
          sessionID: 'native',
          messageID: 'assistant-new',
          type: 'text',
          text: '你好',
          time: { end: 1 }
        }
      }
    }
  yield { type: 'session.status', properties: { sessionID: 'native', status: { type: 'idle' } } }
}
const runtime = {
  session: vi.fn(async () => 'native'),
  setDiagnosticOperation: vi.fn(),
  setProgressListener:
    vi.fn<(listener: ((event: string, details: Record<string, unknown>) => void) | undefined) => void>(),
  release: vi.fn(),
  flushDiagnostic: vi.fn(),
  stop: vi.fn(),
  client: { request, events }
}
async function run(controller = new AbortController(), prompt = 'hello') {
  const stream = await new OpenCodeService().invoke(prompt, fixture, controller, 'legacy-id', {
    recoveryContext: 'must not be resent'
  })
  const collected: AgentStreamEvent[] = []
  await new Promise<void>((resolve) => {
    stream.on('data', (event) => {
      collected.push(event)
      if (event.type !== 'chunk') resolve()
    })
  })
  return collected
}
beforeEach(() => {
  vi.clearAllMocks()
  mode = 'success'
  body = undefined
  historyReads = 0
  failureMessage = 'upstream unavailable'
  transportError = undefined
  recoverTransport = false
  pause = undefined
  mocks.getProcess.mockImplementation(async (...args) => {
    args[5]?.()
    return runtime
  })
  mocks.permission.mockResolvedValue({ behavior: 'allow', updatedInput: {} })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
describe('OpenCode adapter turn lifecycle', () => {
  it.each(['permission-wait', 'browser-wait'] as const)(
    'does not charge %s to execution budget or resubmit after it',
    async (waitingMode) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
      mode = waitingMode
      let ready!: () => void, resume!: () => void
      const entered = new Promise<void>((resolve) => {
        ready = resolve
      })
      pause = {
        ready,
        wait: new Promise<void>((resolve) => {
          resume = resolve
        })
      }
      mocks.permission.mockImplementation(async (_tool, _input, { signal }) => {
        ready()
        await hold(signal)
        return { behavior: 'allow', updatedInput: {} }
      })
      const controller = new AbortController()
      const result = run(controller)
      await entered
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      expect(controller.signal.aborted).toBe(false)
      resume()
      expect((await result).at(-1)?.type).toBe('complete')
      expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
    }
  )
  it.each(['permission-wait', 'browser-wait'] as const)(
    'keeps %s cancellable and bounded without replay',
    async (waitingMode) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
      mode = waitingMode
      let ready!: () => void
      const entered = new Promise<void>((resolve) => {
        ready = resolve
      })
      pause = { ready, wait: new Promise<void>(() => undefined) }
      mocks.permission.mockImplementation(async (_tool, _input, { signal }) => {
        ready()
        await hold(signal)
        return { behavior: 'allow', updatedInput: {} }
      })
      const controller = new AbortController()
      const result = run(controller)
      await entered
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect((await result).at(-1)).toMatchObject({ type: 'error', error: { code: 'agent_human_wait_timeout' } })
      expect(runtime.stop).toHaveBeenCalled()
      expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
    }
  )
  it('cancels a browser human wait immediately without restarting the native task', async () => {
    mode = 'browser-wait'
    let ready!: () => void
    const entered = new Promise<void>((resolve) => {
      ready = resolve
    })
    pause = { ready, wait: new Promise<void>(() => undefined) }
    const controller = new AbortController()
    const result = run(controller)
    await entered
    controller.abort('user cancelled')
    expect((await result).at(-1)?.type).toBe('cancelled')
    expect(runtime.stop).toHaveBeenCalled()
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })
  it('passes multi-attachment provenance and failure lists intact with no extra model submissions', async () => {
    const prompt =
      '合并两份表，说明缺少的资料。\n\n[Attached files saved to the Agent workspace]\n- /workspace/01-收入.xlsx\n- /workspace/02-成本.xlsx\n[Attachments not copied to the Agent workspace]\n- 备注.docx（无法复制到工作区）'
    expect((await run(new AbortController(), prompt)).at(-1)?.type).toBe('complete')
    expect(body.parts).toEqual([{ type: 'text', text: prompt }])
    expect(body.system).toContain('Never silently omit an attachment')
    expect(body.system).toContain('sheet, page or section provenance')
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })
  it('preserves underlying connection evidence after retry budget exhaustion', async () => {
    mode = 'retry'
    transportError = {
      url: 'https://example.test/v1/chat/completions',
      receivedResponse: false,
      error: Object.assign(new Error('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } })
    }
    const result = await run()
    expect(result.at(-1)).toMatchObject({
      type: 'error',
      error: {
        zenFailureStage: 'provider-connect',
        zenRequestUrl: transportError.url,
        zenTransportFailure: { receivedResponse: false, error: { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } } }
      }
    })
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })
  it('does not mislabel a recovered real HTTP error with stale connection evidence', async () => {
    mode = 'error'
    transportError = { receivedResponse: false, error: { code: 'ENOTFOUND' } }
    recoverTransport = true
    const result = await run()
    expect(result.at(-1)).toMatchObject({ type: 'error', error: { status: 503 } })
    expect((result.at(-1) as any).error.zenTransportFailure).toBeUndefined()
  })
  it('keeps a transient failed connection invisible after a successful response', async () => {
    transportError = { receivedResponse: false, error: { code: 'ENOTFOUND' } }
    const result = await run()
    expect(result.at(-1)?.type).toBe('complete')
    expect(result.some((event) => event.type === 'error')).toBe(false)
  })
  it('submits exactly once, restores native history and emits terminal usage', async () => {
    const output = await run()
    expect(output.at(-1)?.type).toBe('complete')
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
    expect(body.parts).toEqual([{ type: 'text', text: 'hello' }])
    expect(JSON.stringify(body)).not.toContain('must not be resent')
    expect(output).toContainEqual(
      expect.objectContaining({
        chunk: expect.objectContaining({ type: 'finish', totalUsage: expect.objectContaining({ inputTokens: 60 }) })
      })
    )
    expect(runtime.release).toHaveBeenCalledOnce()
    const diagnostics = output.find(
      (event) =>
        event.type === 'chunk' && event.chunk.type === 'raw' && event.chunk.rawValue?.type === 'opencode_diagnostics'
    )
    expect(diagnostics).toMatchObject({
      chunk: {
        rawValue: {
          diagnostics: {
            version: 1,
            modelId: 'gpt-test',
            providerId: 'local',
            usage: {},
            performance: { upstreamRequests: 1 }
          }
        }
      }
    })
    const stages = output.flatMap((event) =>
      event.type === 'chunk' && event.chunk.type === 'raw' && event.chunk.rawValue?.type === 'opencode_status'
        ? [event.chunk.rawValue.status]
        : []
    )
    expect(stages.slice(0, 4)).toEqual(['connecting', 'starting', 'restoring', 'submitting'])
    expect(stages).toContain('waiting_model')
    expect(runtime.setProgressListener).toHaveBeenLastCalledWith(undefined)
    expect(mocks.diagnostic).toHaveBeenCalledWith(
      undefined,
      'runtime',
      'complete',
      expect.objectContaining({
        performance: expect.objectContaining({
          outcome: 'completed',
          upstreamRequests: 1,
          firstTextMs: expect.any(Number)
        })
      })
    )
  })
  it('reconciles a lost final stream without replaying the user request', async () => {
    mode = 'disconnect'
    expect((await run()).at(-1)?.type).toBe('complete')
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })
  it.each(['error', 'empty', 'retry'] as const)('stops %s without silent success or replay', async (value) => {
    mode = value
    const result = await run()
    expect(result.at(-1)?.type).toBe('error')
    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })
  it('uses one-time permission replies, never blanket persistent approvals', async () => {
    mode = 'permission'
    expect((await run()).at(-1)?.type).toBe('complete')
    expect(request).toHaveBeenCalledWith('/permission/per1/reply', 'POST', { reply: 'once' }, expect.any(AbortSignal))
  })
  it('redacts credentials in native errors before returning them to the UI', async () => {
    mode = 'error'
    failureMessage = 'Provider failed: Authorization: Bearer sk-private12345678'
    const error = (await run()).at(-1) as Extract<AgentStreamEvent, { type: 'error' }>
    expect(error.type).toBe('error')
    expect(error.error.message).not.toContain('sk-private12345678')
    expect(error.error.message).toContain('[REDACTED]')
  })
  it('cancels before startup without launching the runtime', async () => {
    const controller = new AbortController()
    controller.abort('user cancelled')
    expect((await run(controller)).at(-1)?.type).toBe('cancelled')
    expect(mocks.getProcess).not.toHaveBeenCalled()
  })
  it('identifies a local lease conflict without claiming the upstream failed', async () => {
    const failure = Object.assign(new Error('This new assistant session already has an active task'), {
      name: 'OpenCodeSessionBusyError',
      zenFailureStage: 'runtime-startup',
      zenRuntimeId: 'opencode'
    })
    mocks.getProcess.mockRejectedValue(failure)
    const result = await run()
    expect(result.at(-1)).toEqual({ type: 'error', error: failure })
    expect(request).not.toHaveBeenCalled()
    expect(mocks.diagnostic).toHaveBeenCalledWith(
      undefined,
      'runtime',
      'failed',
      expect.objectContaining({ startup: true, runtime: 'opencode' })
    )
  })
})
