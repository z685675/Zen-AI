import { fork, spawn } from 'node:child_process'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { spawnClaudeProcess } from '../process'

vi.mock('node:child_process', () => ({ fork: vi.fn(), spawn: vi.fn() }))

describe('Claude process startup', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    '/Applications/Zen AI.app/Contents/Resources/claude-code/darwin-arm64/claude',
    'C:\\Program Files\\Zen AI\\resources\\claude-code\\win32-x64\\claude.exe'
  ])('launches native SDK commands directly with all CLI flags: %s', (command) => {
    const controller = new AbortController()
    const env = { HTTPS_PROXY: 'http://localhost:8080', NO_PROXY: 'localhost,127.0.0.1' }
    const args = ['--output-format', 'stream-json', '--input-format', 'stream-json']
    spawnClaudeProcess({ command, args, cwd: '/workspace', env, signal: controller.signal }, ['--require', 'proxy.js'])
    expect(spawn).toHaveBeenCalledWith(command, args, {
      cwd: '/workspace',
      env,
      signal: controller.signal,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    expect(fork).not.toHaveBeenCalled()
  })

  it('keeps Node proxy bootstrapping and IPC for legacy JavaScript CLI versions', () => {
    const controller = new AbortController()
    spawnClaudeProcess(
      { command: 'node', args: ['/sdk/cli.js', '--output-format', 'stream-json'], env: {}, signal: controller.signal },
      ['--require', 'proxy.js']
    )
    expect(fork).toHaveBeenCalledWith(
      '/sdk/cli.js',
      ['--output-format', 'stream-json'],
      expect.objectContaining({
        execArgv: ['--require', 'proxy.js'],
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      })
    )
    expect(spawn).not.toHaveBeenCalled()
  })
})
