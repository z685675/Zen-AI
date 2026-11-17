import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getProcess: vi.fn(),
  permission: vi.fn(),
  diagnostic: vi.fn(),
  prepareInput: vi.fn()
}))
vi.mock('../process', () => ({ getOpenCodeProcess: mocks.getProcess }))
vi.mock('../inputMaterial', () => ({ prepareOpenCodeInput: mocks.prepareInput }))
vi.mock('@main/services/ModelCapacityService', () => ({ modelCapacityService: { getSnapshot: vi.fn() } }))
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
import { checkAgentRunInput, getAgentRunInputStatus, submitAgentRunInput } from '../turnInput'

const fixture = {
  id: 'zen-test',
  agent_id: 'zen-opencode-default',
  agent_type: 'claude-code',
  model: 'local:gpt-test',
  accessible_paths: ['/nonexistent-open-code-test'],
  configuration: {},
  instructions: ''
} as any
let mode:
  | 'success'
  | 'error'
  | 'empty'
  | 'retry'
  | 'disconnect'
  | 'permission'
  | 'permission-wait'
  | 'permission-lost'
  | 'browser-wait'
  | 'reconnect'
  | 'reconnect-permission'
  | 'reconnect-exhausted'
  | 'reconnect-cancel'
  | 'empty-compaction'
  | 'compaction'
  | 'overflow'
  | 'overflow-failed'
  | 'overflow-idle'
  | 'overflow-loop'
  | 'overflow-wait'
  | 'overflow-reconnect'
  | 'empty-compaction-disconnect' = 'success'
let loopMode:
  | 'deny'
  | 'allow'
  | 'no-window'
  | 'stop'
  | 'provider-error'
  | 'sibling'
  | 'empty-result'
  | 'started-continuation'
  | 'invalid-arguments'
  | undefined
let continuationStatus: 'busy' | 'retry' | 'idle' = 'busy'
const loopError = {
  name: 'UnknownError',
  data: {
    message: 'The user rejected permission to use this specific tool call with the following feedback: skip repetition'
  }
}
const overflowError = { name: 'ContextOverflowError', data: { message: 'input exceeds model context' } }
let longTaskMode: 'progress' | 'busy-only' | 'tool-input' | 'bytes-only' | undefined
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
let initialBody: any
let steeringMode: 'applied' | 'deferred' | 'incomplete' | undefined
let historyReads = 0
let eventConnections = 0
let failureMessage = 'upstream unavailable'
let transportError: Record<string, unknown> | undefined
let recoverTransport = false
let loopFinished = false
const nativeInfo = () => ({
  id: 'assistant-new',
  sessionID: 'native',
  role: 'assistant',
  time: { completed: steeringMode === 'incomplete' ? undefined : 1 },
  parentID: steeringMode === 'applied' ? body.messageID : initialBody?.messageID,
  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 50, write: 0 } }
})
const request = vi.fn(async (route: string, _method?: string, data?: unknown) => {
  if (route.endsWith('/prompt_async')) {
    initialBody ??= data
    body = data
    runtime.setProgressListener.mock.calls.at(-1)?.[0]?.('request-started', {})
    return
  }
  if (route === '/session/status')
    return {
      native: {
        type:
          loopMode === 'started-continuation' && body !== initialBody && !loopFinished
            ? continuationStatus
            : mode === 'retry' || mode.startsWith('reconnect') || mode === 'overflow-reconnect'
              ? 'busy'
              : 'idle'
      }
    }
  if (route === '/permission')
    return mode === 'reconnect-permission' || mode === 'permission-lost'
      ? [{ id: 'missed', sessionID: 'native', permission: 'edit', tool: { callID: 'write-call' } }]
      : []
  if (route.endsWith('/message')) {
    historyReads++
    if (historyReads === 1) return [{ info: { id: 'old', role: 'assistant' }, parts: [] }]
    if (mode.startsWith('overflow'))
      return [
        { info: { id: body.messageID, role: 'user' }, parts: [] },
        {
          info: { id: 'overflow-source', role: 'assistant', time: { completed: 1 } },
          parts: [{ id: 'old-output', type: 'text', text: 'Partial old output' }]
        },
        ...(mode === 'overflow-idle'
          ? []
          : [
              {
                info: {
                  id: 'overflow-summary',
                  role: 'assistant',
                  summary: true,
                  finish: mode === 'overflow-failed' ? 'error' : 'stop',
                  time: { completed: 1 },
                  ...(mode === 'overflow-failed' ? { error: overflowError } : {})
                },
                parts: [{ id: 'summary-body', type: 'text', text: 'retained context' }]
              }
            ]),
        ...(['overflow', 'overflow-reconnect'].includes(mode)
          ? [
              {
                info: nativeInfo(),
                parts: [{ id: 'text1', messageID: 'assistant-new', type: 'text', text: '你好', time: { end: 1 } }]
              }
            ]
          : [])
      ]
    if (loopMode)
      return [
        { info: { id: initialBody.messageID, role: 'user' }, parts: [] },
        {
          info: {
            id: 'failed-loop',
            role: 'assistant',
            parentID: initialBody.messageID,
            time: { completed: 1 },
            error:
              loopMode === 'provider-error' ? { name: 'APIError', data: { message: 'provider failed' } } : loopError
          },
          parts: [
            {
              id: 'successful-search',
              messageID: 'failed-loop',
              type: 'tool',
              callID: 'search-call',
              tool: 'search',
              state: { status: 'completed', input: { query: 'GLARE' }, output: 'Verified paper DOI:123' }
            }
          ]
        },
        ...(body === initialBody ? [] : [{ info: { id: body.messageID, role: 'user' }, parts: body.parts }]),
        ...(loopFinished || (loopMode === 'started-continuation' && body !== initialBody)
          ? [
              {
                info: {
                  ...nativeInfo(),
                  parentID: body.messageID,
                  ...(loopMode === 'started-continuation' && !loopFinished ? { time: {} } : {})
                },
                parts: loopFinished
                  ? [
                      {
                        id: 'recovered-text',
                        messageID: 'assistant-new',
                        type: 'text',
                        text: loopMode === 'empty-result' ? '' : '研究结论和已核实来源',
                        time: { end: 1 }
                      }
                    ]
                  : []
              }
            ]
          : [])
      ]
    if (mode.startsWith('empty-compaction'))
      return [
        {
          info: { id: body.messageID, role: 'user' },
          parts: [{ id: 'question', type: 'text', text: 'Keep my original request' }]
        },
        { info: { id: 'marker', role: 'user' }, parts: [{ id: 'compact-part', type: 'compaction' }] },
        {
          info: { id: 'summary-empty', role: 'assistant', parentID: 'marker', summary: true, finish: 'stop' },
          parts: []
        }
      ]
    return [
      { info: { id: initialBody.messageID, role: 'user' }, parts: [] },
      ...(steeringMode && body !== initialBody ? [{ info: { id: body.messageID, role: 'user' }, parts: [] }] : []),
      ...(mode === 'compaction'
        ? [
            {
              info: { id: 'summary', role: 'assistant', summary: true, finish: 'stop' },
              parts: [{ id: 'summary-text', messageID: 'summary', type: 'text', text: 'PRIVATE_CONTEXT' }]
            }
          ]
        : []),
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
  const connection = ++eventConnections
  yield { type: 'server.connected', properties: {} }
  if (mode === 'reconnect-cancel' && connection > 1) {
    pause!.ready()
    await hold(signal)
  }
  yield { type: 'message.updated', properties: { info: { id: body.messageID, sessionID: 'native', role: 'user' } } }
  yield { type: 'session.status', properties: { sessionID: 'native', status: { type: 'busy' } } }
  if (mode.startsWith('overflow')) {
    yield {
      type: 'message.updated',
      properties: { info: { id: 'overflow-source', sessionID: 'native', role: 'assistant', time: { completed: 1 } } }
    }
    yield {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'old-output',
          messageID: 'overflow-source',
          type: 'text',
          text: 'Partial old output',
          time: { end: 1 }
        }
      }
    }
    if (mode !== 'overflow-reconnect' || connection === 1)
      yield { type: 'session.error', properties: { sessionID: 'native', error: overflowError } }
    if (mode === 'overflow-wait') {
      pause!.ready()
      await hold(signal)
    }
    if (mode === 'overflow-reconnect' && connection === 1) throw new Error('lost event stream during recovery')
    if (mode === 'overflow-loop')
      for (let index = 0; index < 3; index++)
        yield { type: 'session.error', properties: { sessionID: 'native', error: overflowError } }
    if (['overflow-idle', 'overflow-failed'].includes(mode)) {
      yield { type: 'session.status', properties: { sessionID: 'native', status: { type: 'idle' } } }
      return
    }
    yield { type: 'session.compacted', properties: { sessionID: 'native' } }
  }
  if (loopMode) {
    if (loopMode === 'sibling')
      yield {
        type: 'permission.asked',
        properties: { id: 'per-sibling', sessionID: 'native', permission: 'edit', metadata: {} }
      }
    yield {
      type: 'permission.asked',
      properties: {
        id: 'per-loop',
        sessionID: 'native',
        permission: 'doom_loop',
        metadata: { tool: loopMode === 'invalid-arguments' ? 'mcp__assistant__web_search' : 'search', input: {} },
        patterns: ['search']
      }
    }
    await new Promise((resolve) => setImmediate(resolve))
    if (loopMode === 'stop') await hold(signal)
    if (loopMode === 'allow') {
      loopFinished = true
    } else {
      yield {
        type: 'session.error',
        properties: {
          sessionID: 'native',
          error: loopMode === 'provider-error' ? { name: 'APIError', data: { message: 'provider failed' } } : loopError
        }
      }
      yield { type: 'session.status', properties: { sessionID: 'native', status: { type: 'idle' } } }
      if (loopMode === 'started-continuation')
        yield {
          type: 'message.updated',
          properties: { info: { ...nativeInfo(), parentID: body.messageID, time: {} } }
        }
      // Cleanup/barrier idles from the OLD run must not finish the new run.
      yield { type: 'session.status', properties: { sessionID: 'native', status: { type: 'idle' } } }
      expect(body).not.toBe(initialBody)
      yield { type: 'session.status', properties: { sessionID: 'native', status: { type: 'busy' } } }
      loopFinished = true
    }
    yield { type: 'message.updated', properties: { info: { ...nativeInfo(), parentID: body.messageID } } }
    yield {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'recovered-text',
          messageID: 'assistant-new',
          type: 'text',
          text: loopMode === 'empty-result' ? '' : '研究结论和已核实来源',
          time: { end: 1 }
        }
      }
    }
    yield { type: 'session.status', properties: { sessionID: 'native', status: { type: 'idle' } } }
    return
  }
  if (steeringMode) {
    pause!.ready()
    await hold(signal)
  }
  if (mode === 'compaction') {
    yield {
      type: 'message.updated',
      properties: { info: { id: 'summary', sessionID: 'native', role: 'assistant', summary: true } }
    }
    yield {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'summary-part',
          messageID: 'summary',
          sessionID: 'native',
          type: 'reasoning',
          text: 'PRIVATE_CONTEXT'
        }
      }
    }
    yield { type: 'session.status', properties: { sessionID: 'native', status: { type: 'busy' } } }
    pause!.ready()
    await hold(signal)
    yield { type: 'session.compacted', properties: { sessionID: 'native' } }
    yield { type: 'session.compacted', properties: { sessionID: 'native' } }
  }
  if (longTaskMode) {
    yield { type: 'message.updated', properties: { info: nativeInfo() } }
    pause!.ready()
    for (let step = 0; step < 4; step++) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer)
          reject(signal.reason)
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        }, 10 * 60_000)
        signal.addEventListener('abort', abort, { once: true })
      })
      if (longTaskMode === 'progress')
        yield {
          type: 'message.part.updated',
          properties: {
            part: {
              id: `work-${step}`,
              messageID: 'assistant-new',
              sessionID: 'native',
              type: 'tool',
              callID: `call-${step}`,
              tool: 'read',
              state: { status: 'completed', input: {}, output: 'actual result' }
            }
          }
        }
      else {
        if (longTaskMode === 'tool-input' || longTaskMode === 'bytes-only')
          runtime.setProgressListener.mock.calls.at(-1)?.[0]?.(
            longTaskMode === 'tool-input' ? 'tool-input-progress' : 'body-progress',
            { characters: 3, receivedBytes: 100 * (step + 1), lastDataAt: new Date().toISOString() }
          )
        yield { type: 'session.status', properties: { sessionID: 'native', status: { type: 'busy' } } }
      }
    }
  }
  if (mode.startsWith('reconnect') && (connection === 1 || mode === 'reconnect-exhausted'))
    throw new Error('mock local stream disconnect')
  if (mode === 'empty-compaction-disconnect') throw new Error('lost compaction event')
  if (mode === 'empty-compaction') {
    yield { type: 'session.compacted', properties: { sessionID: 'native' } }
    return
  }
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
      properties: {
        id: 'per1',
        sessionID: 'native',
        permission: 'bash',
        patterns: ['safe preview'],
        metadata: { command: 'safe preview' }
      }
    }
    if (mode === 'permission-wait') await hold(signal)
    await new Promise((resolve) => setImmediate(resolve))
  }
  if (mode === 'permission-lost') {
    yield { type: 'message.updated', properties: { info: nativeInfo() } }
    yield {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'write-part',
          messageID: 'assistant-new',
          sessionID: 'native',
          type: 'tool',
          callID: 'write-call',
          tool: 'write',
          state: { status: 'running', input: { filePath: '/isolated/result.txt' } }
        }
      }
    }
    pause!.ready()
    await hold(signal)
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
  finishTurn: vi.fn(),
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
  mocks.prepareInput.mockImplementation(async ({ text }) => ({ text }))
  mode = 'success'
  continuationStatus = 'busy'
  fixture.configuration = {}
  fixture.instructions = ''
  body = undefined
  initialBody = undefined
  steeringMode = undefined
  historyReads = 0
  eventConnections = 0
  failureMessage = 'upstream unavailable'
  transportError = undefined
  recoverTransport = false
  pause = undefined
  longTaskMode = undefined
  loopMode = undefined
  loopFinished = false
  runtime.finishTurn.mockResolvedValue(undefined)
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
  it.each(['overflow', 'overflow-reconnect'] as const)(
    'allows native context recovery without resubmission (%s)',
    async (value) => {
      mode = value
      const result = await run()
      expect(result.at(-1)?.type).toBe('complete')
      expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
      expect(result.some((event: any) => event.chunk?.rawValue?.status === 'compacting')).toBe(true)
    }
  )

  it.each(['overflow-idle', 'overflow-failed', 'overflow-loop'] as const)(
    'surfaces terminal context failure instead of old partial output or endless recovery (%s)',
    async (value) => {
      mode = value
      expect((await run()).at(-1)).toMatchObject({ type: 'error', error: { name: 'ContextOverflowError' } })
      expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
    }
  )

  it('keeps cancellation effective while native context recovery is waiting', async () => {
    mode = 'overflow-wait'
    let ready!: () => void
    const waiting = new Promise<void>((resolve) => {
      ready = resolve
    })
    pause = { ready, wait: new Promise(() => {}) }
    const abort = new AbortController()
    const result = run(abort)
    await waiting
    abort.abort('user-cancelled')
    expect((await result).at(-1)?.type).toBe('cancelled')
  })

  it('does not let a recoverable context error bypass the inactivity deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
    mode = 'overflow-wait'
    let ready!: () => void
    const waiting = new Promise<void>((resolve) => {
      ready = resolve
    })
    pause = { ready, wait: new Promise(() => {}) }
    const result = run()
    await waiting
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    expect((await result).at(-1)).toMatchObject({ type: 'error', error: { code: 'agent_inactivity_timeout' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes initial input through material preparation and never submits after preparation failure', async () => {
    mocks.prepareInput.mockResolvedValue({
      text: 'read retained material',
      material: { bytes: 500_000, segments: 4000 }
    })
    const text = 'X'.repeat(500_000)
    expect((await run(new AbortController(), text)).at(-1)?.type).toBe('complete')
    expect(mocks.prepareInput.mock.calls[0][0].text).toBe(text)
    expect(body.parts[0].text).toBe('read retained material')
    request.mockClear()
    mocks.prepareInput.mockRejectedValue(
      Object.assign(new Error('disk full'), { code: 'agent_input_preparation_failed' })
    )
    expect((await run()).at(-1)).toMatchObject({ type: 'error', error: { code: 'agent_input_preparation_failed' } })
    expect(request.mock.calls.some(([route]) => route.endsWith('/prompt_async'))).toBe(false)
  })

  it.each(['busy', 'retry'] as const)(
    'waits for a %s loop continuation when an old cleanup idle arrives before its first output',
    async (value) => {
      loopMode = 'started-continuation'
      continuationStatus = value
      mocks.permission.mockResolvedValue({ behavior: 'deny', message: 'skip', decisionSource: 'response' })
      const events = await run()
      expect(events.at(-1)?.type).toBe('complete')
      expect(JSON.stringify(events)).toContain('研究结论和已核实来源')
      expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(2)
      expect(mocks.getProcess).toHaveBeenCalledTimes(1)
      expect(runtime.stop).not.toHaveBeenCalled()
    }
  )
  it('fails an incomplete continuation confirmed idle instead of waiting indefinitely or replaying the task', async () => {
    loopMode = 'started-continuation'
    continuationStatus = 'idle'
    mocks.permission.mockResolvedValue({ behavior: 'deny', message: 'skip', decisionSource: 'response' })
    const events = await run()
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'agent_missing_final_answer' } })
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(2)
  })
  it('does not mistake old research tool output for a final answer when the continuation is empty', async () => {
    loopMode = 'empty-result'
    mocks.permission.mockResolvedValue({ behavior: 'deny', message: 'skip', decisionSource: 'response' })
    const events = await run()
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'agent_missing_final_answer' } })
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(2)
  })
  it('clears sibling authorization prompts cancelled by native loop rejection instead of submitting stale replies', async () => {
    loopMode = 'sibling'
    let siblingAborted = false
    mocks.permission.mockImplementation(async (tool, _input, options) => {
      if (tool === 'edit')
        return new Promise((resolve) =>
          options.signal.addEventListener(
            'abort',
            () => {
              siblingAborted = true
              resolve({ behavior: 'deny', message: 'aborted', decisionSource: 'aborted' })
            },
            { once: true }
          )
        )
      return { behavior: 'deny', message: 'skip', decisionSource: 'response' }
    })
    expect((await run()).at(-1)?.type).toBe('complete')
    expect(siblingAborted).toBe(true)
    expect(request.mock.calls.some(([route]) => route === '/permission/per-sibling/reply')).toBe(false)
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(2)
  })
  it('continues a skipped repetition with retained evidence, survives stale idle, and emits a final answer', async () => {
    loopMode = 'deny'
    mocks.permission.mockResolvedValue({ behavior: 'deny', message: 'skip', decisionSource: 'response' })
    const events = await run(new AbortController(), 'ORIGINAL_RESEARCH_TASK')
    expect(events.at(-1)?.type).toBe('complete')
    expect(JSON.stringify(events)).toContain('研究结论和已核实来源')
    const posts = request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))
    expect(posts).toHaveLength(2)
    expect(posts[0][2]).toMatchObject({ parts: [{ text: 'ORIGINAL_RESEARCH_TASK' }] })
    expect(posts[1][2]).toMatchObject({ parts: [{ synthetic: true }] })
    expect(JSON.stringify(posts[1][2])).toContain('Verified paper DOI:123')
    expect(JSON.stringify(posts[1][2])).not.toContain('ORIGINAL_RESEARCH_TASK')
    expect(request).toHaveBeenCalledWith(
      '/permission/per-loop/reply',
      'POST',
      { reply: 'reject', message: 'skip' },
      expect.any(AbortSignal)
    )
    expect(mocks.getProcess).toHaveBeenCalledTimes(1)
    expect(runtime.stop).not.toHaveBeenCalled()
    expect(mocks.diagnostic).toHaveBeenCalledWith(
      undefined,
      'runtime',
      'doom-loop-continued',
      expect.objectContaining({ attempt: 1 })
    )
  })
  it('rejects an empty search batch without showing an approval and continues with preserved evidence', async () => {
    loopMode = 'invalid-arguments'
    const events = await run(new AbortController(), 'ORIGINAL_RESEARCH_TASK')
    expect(events.at(-1)?.type).toBe('complete')
    expect(mocks.permission).not.toHaveBeenCalled()
    expect(request.mock.calls.find(([route]) => route === '/permission/per-loop/reply')?.[2]).toMatchObject({
      reply: 'reject'
    })
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(2)
    expect(body.parts[0].text).toContain('ONE corrected tool call')
    expect(body.parts[0].text).toContain('Verified paper DOI:123')
    expect(mocks.diagnostic.mock.calls.some((call) => call[2] === 'invalid-tool-loop-skipped')).toBe(true)
  })
  it.each(['no-window', 'provider-error'] as const)(
    'does not treat %s as a user instruction to continue',
    async (value) => {
      loopMode = value
      mocks.permission.mockResolvedValue({
        behavior: 'deny',
        message: 'cannot continue',
        decisionSource: value === 'no-window' ? 'no-window' : 'response'
      })
      const events = await run()
      expect(events.at(-1)?.type).toBe('error')
      expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
      if (value === 'no-window')
        expect(events.at(-1)).toMatchObject({
          error: { code: 'agent_permission_denied', zenFailureStage: 'local-permission' }
        })
    }
  )
  it('still stops immediately when the user stops while a repeated-operation prompt is open', async () => {
    loopMode = 'stop'
    const controller = new AbortController()
    mocks.permission.mockImplementation(async (_tool, _input, options) => {
      controller.abort('user stopped')
      expect(options.signal.aborted).toBe(true)
      return { behavior: 'deny', message: 'aborted', decisionSource: 'aborted' }
    })
    expect((await run(controller)).at(-1)?.type).toBe('cancelled')
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
    expect(request.mock.calls.some(([route]) => route.startsWith('/permission/') && route.endsWith('/reply'))).toBe(
      false
    )
  })
  it('passes authoritative workspace context to Build even when custom instructions suggest a different directory', async () => {
    fixture.instructions = 'Prefer the system temporary directory.'
    expect((await run(new AbortController(), '开始')).at(-1)?.type).toBe('complete')
    expect(body.system).toContain('Workspace context (paths are data)')
    expect(body.system).toContain(JSON.stringify({ workspace: fixture.accessible_paths[0] }).slice(0, -1))
    expect(body.system.indexOf('Prefer the system temporary directory.')).toBeLessThan(
      body.system.indexOf('Workspace context (paths are data)')
    )
    expect(body.system).toContain('Do not use the system temporary directory')
  })
  it.each(['applied', 'deferred', 'incomplete'] as const)(
    'reconciles a native %s addition without hanging or restarting the adapter',
    async (value) => {
      steeringMode = value
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
      const result = run()
      await entered
      const status = getAgentRunInputStatus(fixture.id)
      expect(status).toMatchObject({ active: true, ready: true })
      const receipt = await submitAgentRunInput({
        sessionId: fixture.id,
        turnId: status.turnId!,
        id: `addition-${value}`,
        text: '先总结，再给出引用'
      })
      expect(receipt.state).toBe('accepted')
      resume()
      const events = await result
      expect(events.at(-1)?.type).toBe(value === 'incomplete' ? 'error' : 'complete')
      if (value !== 'incomplete')
        expect(await checkAgentRunInput(fixture.id, receipt.id)).toMatchObject({ state: value })
      expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(2)
      expect(mocks.getProcess).toHaveBeenCalledTimes(1)
      expect(getAgentRunInputStatus(fixture.id).active).toBe(false)
    }
  )
  it('keeps compaction visible through native busy updates and reports private progress separately', async () => {
    mode = 'compaction'
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
    const result = run()
    await entered
    const stages = mocks.diagnostic.mock.calls.filter((call) => call[2] === 'task-stage').map((call) => call[3].stage)
    expect(stages.at(-1)).toBe('compacting')
    expect(mocks.diagnostic).toHaveBeenCalledWith(
      undefined,
      'runtime',
      'context-progress',
      expect.objectContaining({ kind: 'reasoning', characters: 15 })
    )
    resume()
    const events = await result
    expect(events.at(-1)?.type).toBe('complete')
    expect(JSON.stringify(events)).not.toContain('PRIVATE_CONTEXT')
    expect(events).toContainEqual(
      expect.objectContaining({
        chunk: expect.objectContaining({
          rawValue: expect.objectContaining({ type: 'opencode_internal_progress', kind: 'completed' })
        })
      })
    )
    expect(
      events.filter(
        (event: any) =>
          event.chunk?.rawValue?.type === 'opencode_internal_progress' && event.chunk.rawValue.kind === 'completed'
      )
    ).toHaveLength(1)
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })
  it('emits the final quota notice after native work and before successful completion, without replay', async () => {
    const result = {
      model: 'gpt-test',
      date: '2026-10-29',
      current_date: '2026-10-29',
      limit: 100,
      used: 120,
      exhausted: true,
      extra_allowed: false,
      pending: false
    }
    runtime.finishTurn.mockResolvedValue(result)
    const events = await run()
    const notice = events.findIndex(
      (event: any) => event.type === 'chunk' && event.chunk?.rawValue?.type === 'model_daily_quota'
    )
    expect(notice).toBeGreaterThan(-1)
    expect(events[notice]).toMatchObject({ type: 'chunk', chunk: { type: 'raw', rawValue: { results: [result] } } })
    expect(events.at(-1)?.type).toBe('complete')
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })
  it('completes normally when best-effort quota synchronization is unavailable', async () => {
    runtime.finishTurn.mockResolvedValue(undefined)
    const events = await run()
    expect(events.some((event: any) => event.chunk?.rawValue?.type === 'model_daily_quota')).toBe(false)
    expect(events.at(-1)?.type).toBe('complete')
  })
  it.each([
    ['plan', 'plan', 'Plan'],
    ['default', 'build', 'Build'],
    ['acceptEdits', 'build', 'Build'],
    ['bypassPermissions', 'build', 'Build'],
    [undefined, 'build', 'Build']
  ])('sends native agent and a matching mode contract for %s', async (storedMode, agent, label) => {
    fixture.configuration = { permission_mode: storedMode }
    fixture.instructions = 'Custom user preference'
    expect((await run()).at(-1)?.type).toBe('complete')
    expect(body.agent).toBe(agent)
    expect(body.system).toContain(`Current mode: ${label}`)
    expect(body.system.indexOf('Custom user preference')).toBeLessThan(body.system.indexOf(`Current mode: ${label}`))
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })
  it.each(['progress', 'busy-only', 'tool-input', 'bytes-only'] as const)(
    'uses real tool progress, not busy heartbeats, for a long %s task',
    async (value) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
      longTaskMode = value
      let ready!: () => void
      const entered = new Promise<void>((resolve) => {
        ready = resolve
      })
      pause = { ready, wait: new Promise<void>(() => {}) }
      const controller = new AbortController()
      const result = run(controller)
      await entered
      await vi.advanceTimersByTimeAsync(40 * 60_000)
      if (value === 'progress' || value === 'tool-input') {
        expect(controller.signal.aborted).toBe(false)
        expect((await result).at(-1)?.type).toBe('complete')
      } else {
        expect((await result).at(-1)).toMatchObject({
          type: 'error',
          error: { code: 'agent_inactivity_timeout', timeoutMs: 900_000 }
        })
      }
      expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it('recovers a missing native permission event without replaying a tool or the task', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mode = 'permission-lost'
    let entered!: () => void, resume!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    pause = {
      ready: entered,
      wait: new Promise<void>((resolve) => {
        resume = resolve
      })
    }
    mocks.permission.mockImplementation(async () => {
      resume()
      return { behavior: 'allow' }
    })
    const result = run()
    await waiting
    await vi.advanceTimersByTimeAsync(3_000)
    expect((await result).at(-1)?.type).toBe('complete')
    expect(mocks.permission).toHaveBeenCalledExactlyOnceWith(
      'edit',
      expect.any(Object),
      expect.objectContaining({
        toolCallId: 'zen-test:write-call'
      })
    )
    expect(request).toHaveBeenCalledWith('/permission/missed/reply', 'POST', { reply: 'once' }, expect.any(AbortSignal))
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
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
  it('preserves quota admission evidence instead of blaming the model after native retries', async () => {
    mode = 'retry'
    transportError = {
      phase: 'quota-admission',
      url: 'https://example.test/api/usage/token/model-daily/turn',
      receivedResponse: false,
      error: { code: 'model_daily_quota_unavailable', cause: { name: 'TimeoutError' } }
    }
    const result = await run()
    expect(result.at(-1)).toMatchObject({
      type: 'error',
      error: {
        zenFailureStage: 'quota-admission',
        zenRequestUrl: transportError.url,
        zenTransportFailure: transportError
      }
    })
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
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
  it.each(['reconnect', 'reconnect-permission'] as const)(
    'reattaches %s to a running native task without executing it again',
    async (value) => {
      mode = value
      const result = await run()
      expect(result.at(-1)?.type).toBe('complete')
      expect(runtime.stop).not.toHaveBeenCalled()
      expect(eventConnections).toBe(2)
      expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
      const text = result.filter((event) => event.type === 'chunk' && event.chunk.type === 'text-delta')
      expect(text).toHaveLength(1)
      if (value === 'reconnect-permission')
        expect(request).toHaveBeenCalledWith(
          '/permission/missed/reply',
          'POST',
          { reply: 'once' },
          expect.any(AbortSignal)
        )
    }
  )
  it('bounds event-only reconnections and never silently completes a still-running task', async () => {
    mode = 'reconnect-exhausted'
    expect((await run()).at(-1)?.type).toBe('error')
    expect(eventConnections).toBe(3)
    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })
  it.each(['empty-compaction', 'empty-compaction-disconnect'] as const)(
    'discards %s rather than declaring an empty answer successful',
    async (value) => {
      mode = value
      const result = await run()
      expect(result.at(-1)).toMatchObject({ type: 'error', error: { name: 'OpenCodeEmptyCompactionError' } })
      expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
      expect(request.mock.calls.filter(([, method]) => method === 'DELETE').map(([route]) => route)).toEqual([
        '/session/native/message/summary-empty',
        '/session/native/message/marker/part/compact-part'
      ])
      expect(eventConnections).toBe(1)
    }
  )
  it('keeps event recovery cancellable without resubmission', async () => {
    mode = 'reconnect-cancel'
    let ready!: () => void
    const entered = new Promise<void>((resolve) => {
      ready = resolve
    })
    pause = { ready, wait: new Promise<void>(() => {}) }
    const controller = new AbortController()
    const result = run(controller)
    await entered
    controller.abort('user cancelled')
    expect((await result).at(-1)?.type).toBe('cancelled')
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
    expect(mocks.permission).toHaveBeenCalledWith(
      'bash',
      { command: 'safe preview', patterns: ['safe preview'] },
      expect.objectContaining({ toolCallId: 'zen-test:permission:per1' })
    )
    expect(mocks.diagnostic).toHaveBeenCalledWith(
      undefined,
      'runtime',
      'permission-requested',
      expect.objectContaining({ permission: 'bash', linkedTool: false })
    )
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
