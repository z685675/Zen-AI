import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  access: vi.fn(),
  read: vi.fn(),
  mkdir: vi.fn(),
  resolve: vi.fn(),
  record: vi.fn(),
  request: vi.fn(),
  gateway: vi.fn(),
  gatewayStop: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:fs/promises', () => ({ default: { access: mocks.access, readFile: mocks.read, mkdir: mocks.mkdir } }))
vi.mock('@main/utils', () => ({
  getDataPath: () => '/owned/OpenCode',
  getResourcePath: () => '/resources',
  toAsarUnpackedPath: (path: string) => path
}))
vi.mock('@main/services/DiagnosticEvidenceService', () => ({ recordMainDiagnostic: mocks.record }))
vi.mock('@main/services/ConfigManager', () => ({ configManager: { getClientId: () => 'test-installation' } }))
vi.mock('@main/utils/process', () => ({ getBinaryPath: async () => '/owned/tools' }))
vi.mock('@main/apiServer/routes/assistant-mcp', () => ({
  registerAssistantMcpContext: vi.fn(),
  cleanupAssistantMcpContext: vi.fn(),
  touchAssistantMcpContext: () => true
}))
vi.mock('@main/apiServer/routes/browser-mcp', () => ({
  registerBrowserMcpContext: vi.fn(),
  cleanupBrowserMcpContext: vi.fn(),
  touchBrowserMcpContext: () => true
}))
vi.mock('../offline', () => ({ prepareOpenCodeOfflineConfig: vi.fn() }))
vi.mock('../executable', () => ({ resolveOpenCodeExecutable: mocks.resolve }))
vi.mock('../gateway', () => ({ createOpenCodeGateway: mocks.gateway }))
vi.mock('../client', () => ({
  OpenCodeClient: class {
    request = mocks.request
  }
}))

let child: EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  exitCode: null
  signalCode: null
  kill: ReturnType<typeof vi.fn>
}
let launch: 'listen' | 'error' | 'exit' | 'wait' = 'listen'
const config = () => ({
  provider: {
    'zen-selected': {
      options: {
        baseURL: 'http://localhost/v1',
        apiKey: 'opaque-api-secret',
        headers: { 'X-Custom': 'opaque-header-secret' }
      }
    }
  },
  mcp: { zen: { headers: { Authorization: 'Bearer opaque-mcp-secret' } } },
  permission: {}
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  launch = 'listen'
  mocks.record.mockImplementation(() => undefined)
  mocks.access.mockResolvedValue(undefined)
  mocks.mkdir.mockResolvedValue(undefined)
  mocks.read.mockRejectedValue(Object.assign(new Error('missing binding'), { code: 'ENOENT' }))
  mocks.resolve.mockReturnValue('/owned/runtime/opencode')
  mocks.gateway.mockResolvedValue({
    baseURL: 'http://127.0.0.1:9876/v1',
    token: 'opaque-gateway-secret',
    stop: mocks.gatewayStop,
    setOperation: vi.fn()
  })
  mocks.spawn.mockImplementation((executable: string) => {
    if (executable === 'taskkill') return new EventEmitter()
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 987654,
      exitCode: null,
      signalCode: null,
      kill: vi.fn()
    })
    queueMicrotask(() => {
      if (launch === 'listen') child.stdout.write('opencode server listening on http://127.0.0.1:12345\n')
      if (launch === 'error') child.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }))
      if (launch === 'exit') {
        child.stderr.write('opaque-api-secret startup failed\n')
        child.emit('exit', 7, null)
      }
    })
    return child
  })
  mocks.request.mockImplementation(async (route: string) => {
    if (route === '/global/health') return { healthy: true, version: '1.18.35' }
    if (route === '/config')
      return JSON.parse(mocks.spawn.mock.calls.find((call) => call[0] !== 'taskkill')![2].env.OPENCODE_CONFIG_CONTENT)
  })
})
afterEach(async () => {
  const mod = await import('../process')
  mod.stopOpenCodeProcesses()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const events = (id: string) => mocks.record.mock.calls.filter((call) => call[0] === id)
const start = async (key = 'session', id = 'turn-1', signal = new AbortController().signal) => {
  const mod = await import('../process')
  return mod.getOpenCodeProcess(key, '/workspace', config(), ['/workspace'], signal, undefined, id)
}

describe('OpenCode operation-scoped lifecycle evidence', () => {
  it('starts independently of background provisioning and includes the private tool directory', async () => {
    const runtime = await start()
    const options = mocks.spawn.mock.calls.find((call) => call[0] !== 'taskkill')![2]
    expect(options.env.PATH.split(process.platform === 'win32' ? ';' : ':')[0]).toBe('/owned/tools')
    expect(mocks.spawn.mock.calls.filter((call) => call[0] !== 'taskkill')).toHaveLength(1)
    runtime.release()
  })
  it('does not start a runtime for Skill inspection and reads only the existing local inventory', async () => {
    const mod = await import('../process')
    expect(await mod.inspectOpenCodeSkills('unstarted')).toMatchObject({ status: 'not-running', skills: [] })
    expect(mocks.spawn).not.toHaveBeenCalled()
    const runtime = await start()
    const previous = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation(async (route, ...args) =>
      route === '/skill' ? [{ name: 'xlsx', location: '/skills/xlsx/SKILL.md' }] : previous(route, ...args)
    )
    expect(await mod.inspectOpenCodeSkills('session')).toMatchObject({
      status: 'observed',
      skills: [{ name: 'xlsx', path: '/skills/xlsx/SKILL.md' }]
    })
    runtime.skillsStale = true
    expect((await mod.inspectOpenCodeSkills('session')).refreshRequired).toBe(true)
    const count = events('turn-1').filter((event) => event[2] === 'process-snapshot').length
    mod.flushOpenCodeDiagnostic('other-turn')
    expect(events('turn-1').filter((event) => event[2] === 'process-snapshot')).toHaveLength(count)
    mod.flushOpenCodeDiagnostic('turn-1')
    expect(events('turn-1').filter((event) => event[2] === 'process-snapshot')).toHaveLength(count + 1)
    mocks.request.mockRejectedValue(new Error('local unavailable'))
    expect(await mod.inspectOpenCodeSkills('session')).toMatchObject({ status: 'unavailable', skills: [] })
    expect(mocks.spawn.mock.calls.filter((call) => call[0] !== 'taskkill')).toHaveLength(1)
  })
  it('binds diagnostics before startup and observes the actual health version without logging stdout or configuration', async () => {
    const runtime = await start()
    child.stdout.write('PRIVATE_STDOUT_CONTENT\n')
    runtime.flushDiagnostic()
    expect(events('turn-1').find((event) => event[2] === 'process-health')?.[3]).toMatchObject({
      observedVersion: '1.18.35',
      expectedVersion: '1.18.35',
      healthy: true
    })
    expect(
      events('turn-1')
        .filter((event) => event[2] === 'startup-stage')
        .map((event) => event[3].phase)
    ).toEqual([
      'workspace',
      'offline-resources',
      'local-gateway',
      'executable-resolution',
      'process-spawn',
      'server-listen',
      'health-check',
      'configuration-check',
      'history-binding',
      'ready'
    ])
    const text = JSON.stringify(events('turn-1'))
    expect(text).not.toContain('PRIVATE_STDOUT_CONTENT')
    expect(text).not.toContain('opaque-api-secret')
    expect(mocks.spawn.mock.calls.filter((call) => call[0] !== 'taskkill')).toHaveLength(1)
  })

  it('records startup failures, including failures before spawn', async () => {
    mocks.resolve.mockImplementation(() => {
      throw new Error('missing binary')
    })
    await expect(start()).rejects.toThrow('missing binary')
    expect(events('turn-1').find((event) => event[2] === 'failed')?.[3]).toMatchObject({
      startup: true,
      phase: 'executable-resolution'
    })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it.each(['error', 'exit'] as const)('retains spawn %s evidence with the startup operation ID', async (mode) => {
    launch = mode
    await expect(start()).rejects.toThrow(mode === 'error' ? 'EACCES' : 'exited during startup')
    const failure = events('turn-1').find((event) => event[2] === (mode === 'error' ? 'process-error' : 'process-exit'))
    expect(failure).toBeDefined()
    if (mode === 'exit') expect(failure![3]).toMatchObject({ code: 7, signal: null, unexpected: true, active: true })
    expect(JSON.stringify(events('turn-1'))).not.toContain('opaque-api-secret')
  })

  it('records an unexpected active exit and the final pipe data separately from a normal stop', async () => {
    const runtime = await start()
    child.stderr.write('opaque-header-secret tools failed\n')
    child.emit('exit', null, 'SIGABRT')
    child.stderr.write('FINAL_PIPE_CAUSE\n')
    child.emit('close', null, 'SIGABRT')
    expect(events('turn-1').find((event) => event[2] === 'process-exit')?.[3]).toMatchObject({
      code: null,
      signal: 'SIGABRT',
      unexpected: true,
      active: true
    })
    expect(
      events('turn-1')
        .filter((event) => event[2] === 'process-snapshot')
        .at(-1)?.[3].stderr.text
    ).toContain('FINAL_PIPE_CAUSE')
    expect(JSON.stringify(events('turn-1'))).not.toContain('opaque-header-secret')
    runtime.release()
  })

  it('does not label user cancellation or idle reclaim as an unexpected active exit', async () => {
    const runtime = await start()
    runtime.stop('user-cancelled')
    child.emit('exit', 1, null)
    expect(events('turn-1').find((event) => event[2] === 'process-exit')?.[3]).toMatchObject({
      unexpected: false,
      stopReason: 'user-cancelled'
    })
  })

  it('keeps startup stderr through repeated binding, resets it for a new turn and isolates simultaneous sessions', async () => {
    const runtime = await start()
    child.stderr.write('FIRST_TURN_ONLY\n')
    runtime.setDiagnosticOperation('turn-1')
    runtime.flushDiagnostic()
    expect(
      events('turn-1')
        .filter((event) => event[2] === 'process-snapshot')
        .at(-1)?.[3].stderr.text
    ).toContain('FIRST_TURN_ONLY')
    runtime.release()
    const reused = await start('session', 'turn-2')
    expect(reused).toBe(runtime)
    child.stderr.write('SECOND_TURN_ONLY\n')
    reused.flushDiagnostic()
    expect(JSON.stringify(events('turn-2'))).not.toContain('FIRST_TURN_ONLY')
    const other = await start('another-session', 'turn-other')
    child.stderr.write('OTHER_SESSION_ONLY\n')
    other.flushDiagnostic()
    expect(JSON.stringify(events('turn-2'))).not.toContain('OTHER_SESSION_ONLY')
    expect(JSON.stringify(events('turn-other'))).not.toContain('SECOND_TURN_ONLY')
  })

  it('does not let a diagnostic observer failure prevent normal startup', async () => {
    mocks.record.mockImplementation(() => {
      throw new Error('diagnostic unavailable')
    })
    const runtime = await start()
    expect(runtime).toBeDefined()
    expect(() => runtime.flushDiagnostic()).not.toThrow()
  })
  it('does not let a stderr snapshot failure interrupt the task or hide collector failure', async () => {
    const runtime = await start()
    const { OpenCodeStderr: CurrentStderr } = await import('../stderr')
    vi.spyOn(CurrentStderr.prototype, 'snapshot').mockImplementation(() => {
      throw new Error('snapshot failed')
    })
    expect(() => runtime.flushDiagnostic()).not.toThrow()
    expect(events('turn-1').at(-1)?.[3]).toMatchObject({ collectionStatus: 'failed' })
  })
})
