import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ files: new Map<string, string>(), inspect: vi.fn() }))
vi.mock('node:os', () => ({
  default: { type: () => 'Windows_NT', release: () => 'test-release', version: () => 'test-version' }
}))
vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: (path: string, value: string) => mocks.files.set(path, value),
    readFileSync: (path: string) => {
      if (path.replaceAll('\\', '/').endsWith('opencode-ai/package.json')) return JSON.stringify({ version: '1.18.35' })
      const value = mocks.files.get(path)
      if (value === undefined) throw new Error('ENOENT')
      return value
    },
    readdirSync: () => [...mocks.files.keys()].map((path) => path.split(/[\\/]/).at(-1)),
    statSync: () => ({ mtimeMs: 1 }),
    unlinkSync: (path: string) => mocks.files.delete(path),
    existsSync: () => true,
    accessSync: vi.fn(),
    constants: { X_OK: 1 }
  }
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/owned-user-data', getAppPath: () => '/app', getVersion: () => '1.1.71', isPackaged: true }
}))
vi.mock('../agents/services/opencode/executable', () => ({ inspectOpenCodeExecutable: mocks.inspect }))
vi.mock('../agents/services/opencode/process', () => ({ flushOpenCodeDiagnostic: vi.fn() }))
vi.mock('../agents/services/codex/executable', () => ({
  resolveCodexExecutable: () => ({ executablePath: '/old/codex' })
}))
vi.mock('../agents/services/claudecode/executable', () => ({ resolveClaudeExecutablePath: () => '/old/claude' }))

beforeEach(() => {
  vi.resetModules()
  mocks.files.clear()
  mocks.inspect
    .mockReset()
    .mockReturnValue({ expectedVersion: '1.18.35', path: '/new/opencode', exists: true, snapshotTime: 'export-time' })
})

describe('native diagnostic snapshot collection', () => {
  it('exports the new runtime independently of legacy executable checks', async () => {
    const mod = await import('../DiagnosticEvidenceService')
    mod.beginMainDiagnostic('native-turn', { sessionId: 'session' })
    mod.recordMainDiagnostic('native-turn', 'runtime', 'process-health', {
      runtime: 'opencode',
      expectedVersion: '1.18.35',
      observedVersion: '1.18.35'
    })
    const result = await mod.collectMainDiagnostic('native-turn')
    expect(result.environment.executables.opencode).toMatchObject({
      expectedVersion: '1.18.35',
      exists: true,
      snapshotTime: 'export-time'
    })
    expect(result.environment.componentVersions['opencode-ai']).toBe('1.18.35')
    expect(result.evidence?.events[0].details?.observedVersion).toBe('1.18.35')
  })

  it('persists final pipe/exit evidence that arrives after the task failure, surviving a recorder restart', async () => {
    const mod = await import('../DiagnosticEvidenceService')
    mod.beginMainDiagnostic('native-turn', { sessionId: 'session' })
    mod.recordMainDiagnostic('native-turn', 'runtime', 'failed', { runtime: 'opencode', error: 'task stopped' })
    mod.recordMainDiagnostic('native-turn', 'runtime', 'process-snapshot', {
      runtime: 'opencode',
      stderr: { text: 'FINAL_ERROR api_key=fake-secret' }
    })
    mod.recordMainDiagnostic('native-turn', 'runtime', 'process-exit', {
      runtime: 'opencode',
      code: 7,
      signal: null,
      unexpected: true,
      active: true
    })
    mod.recordMainDiagnostic('native-turn', 'runtime', 'process-close', { runtime: 'opencode', code: 7 })
    expect([...mocks.files.values()].join('\n')).not.toContain('fake-secret')
    vi.resetModules()
    const restarted = await import('../DiagnosticEvidenceService')
    const result = await restarted.collectMainDiagnostic('native-turn')
    expect(result.snapshotStatus).toBe('collected-from-disk')
    expect(result.evidence?.events.map((event) => event.event)).toEqual([
      'failed',
      'process-snapshot',
      'process-exit',
      'process-close'
    ])
    expect(result.evidence?.events[2].details).toMatchObject({ code: 7, unexpected: true })
  })

  it('returns explicit missing evidence and still collects other data when executable inspection fails', async () => {
    mocks.inspect.mockImplementation(() => {
      throw new Error('inspection failed')
    })
    const mod = await import('../DiagnosticEvidenceService')
    const result = await mod.collectMainDiagnostic('old-or-missing-turn')
    expect(result).toMatchObject({
      snapshotStatus: 'unavailable',
      logStatus: 'unavailable-or-no-matching-logs',
      environment: { executables: { opencode: { collectionStatus: 'failed' } } }
    })
    expect(result.environment.osRelease).toBe('test-release')
    await expect(mod.collectMainDiagnostic('../invalid')).rejects.toThrow('Invalid')
  })
})
