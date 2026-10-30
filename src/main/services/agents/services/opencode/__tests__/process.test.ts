import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rename: vi.fn(),
  mkdir: vi.fn(),
  cp: vi.fn(),
  copyFile: vi.fn(),
  assistant: vi.fn(() => true),
  browser: vi.fn(() => true)
}))
vi.mock('@main/utils', () => ({
  getDataPath: () => '/owned/OpenCode',
  getResourcePath: () => '/resources',
  toAsarUnpackedPath: (value: string) => value
}))
vi.mock('@main/services/ConfigManager', () => ({ configManager: { getClientId: () => 'test-installation' } }))
vi.mock('@main/utils/process', () => ({ getBinaryPath: async () => '/owned/tools' }))
vi.mock('@main/apiServer/routes/assistant-mcp', () => ({
  cleanupAssistantMcpContext: vi.fn(),
  registerAssistantMcpContext: vi.fn(),
  touchAssistantMcpContext: mocks.assistant
}))
vi.mock('@main/apiServer/routes/browser-mcp', () => ({
  cleanupBrowserMcpContext: vi.fn(),
  registerBrowserMcpContext: vi.fn(),
  touchBrowserMcpContext: mocks.browser
}))
vi.mock('node:fs/promises', () => ({
  default: { rename: mocks.rename, mkdir: mocks.mkdir, cp: mocks.cp, copyFile: mocks.copyFile }
}))
vi.mock('../offline', () => ({ prepareOpenCodeOfflineConfig: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  mocks.rename.mockResolvedValue(undefined)
  mocks.mkdir.mockResolvedValue(undefined)
  mocks.cp.mockResolvedValue(undefined)
  mocks.copyFile.mockResolvedValue(undefined)
  mocks.assistant.mockReturnValue(true)
  mocks.browser.mockReturnValue(true)
})
describe('OpenCode owned process leases', () => {
  it('reuses lightweight WeChat/schedule runtimes that intentionally have no browser context', async () => {
    const mod = await import('../process')
    const start = vi.spyOn(mod.OpenCodeProcess.prototype, 'start').mockResolvedValue()
    mocks.browser.mockReturnValue(false)
    const config = { permission: { '*': 'deny', bash: 'deny', mcp__assistant__python_execute: 'deny' } }
    const runtime = await mod.getOpenCodeProcess('wechat', '/workspace', config, [], new AbortController().signal)
    runtime.release()
    expect(await mod.getOpenCodeProcess('wechat', '/workspace', config, [], new AbortController().signal)).toBe(runtime)
    expect(start).toHaveBeenCalledOnce()
    runtime.release()
    runtime.stop()
  })

  it('awaits termination when the same session configuration changes', async () => {
    const mod = await import('../process')
    const start = vi.spyOn(mod.OpenCodeProcess.prototype, 'start').mockResolvedValue()
    const runtime = await mod.getOpenCodeProcess('wechat', '/workspace', {}, [], new AbortController().signal)
    runtime.release()
    let finish!: () => void
    vi.spyOn(runtime, 'stopAndWait').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            runtime.stop()
            resolve()
          }
        })
    )
    const next = mod.getOpenCodeProcess('wechat', '/workspace', { model: 'new' }, [], new AbortController().signal)
    expect(start).toHaveBeenCalledOnce()
    await expect(mod.getOpenCodeProcess('wechat', '/workspace', {}, [], new AbortController().signal)).rejects.toThrow(
      'active task'
    )
    finish()
    const replacement = await next
    expect(replacement).not.toBe(runtime)
    replacement.release()
    replacement.stop()
  })
  it('does not start a native process during a protected Skill update and releases the gate on failure', async () => {
    const mod = await import('../process')
    const start = vi.spyOn(mod.OpenCodeProcess.prototype, 'start').mockResolvedValue()
    await expect(
      mod.withOpenCodeSkillMutation(async () => {
        await expect(
          mod.getOpenCodeProcess('mutation', '/workspace', {}, [], new AbortController().signal)
        ).rejects.toThrow('being updated')
        throw new Error('update failed')
      })
    ).rejects.toThrow('update failed')
    expect(start).not.toHaveBeenCalled()
    const runtime = await mod.getOpenCodeProcess('mutation', '/workspace', {}, [], new AbortController().signal)
    await expect(mod.withOpenCodeSkillMutation(async () => undefined)).rejects.toThrow('Stop active')
    runtime.release()
    runtime.stop()
  })
  it('does not interrupt active work on skill changes and refreshes on the next explicit turn', async () => {
    const mod = await import('../process')
    const start = vi.spyOn(mod.OpenCodeProcess.prototype, 'start').mockResolvedValue()
    const first = await mod.getOpenCodeProcess('skills-session', '/workspace', {}, [], new AbortController().signal)
    expect(mod.hasActiveOpenCodeTask()).toBe(true)
    mod.invalidateOpenCodeSkillInventory()
    expect(first.active).toBe(true)
    expect(first.skillsStale).toBe(true)
    first.release()
    expect(mod.hasActiveOpenCodeTask()).toBe(false)
    const second = await mod.getOpenCodeProcess('skills-session', '/workspace', {}, [], new AbortController().signal)
    expect(second).not.toBe(first)
    expect(start).toHaveBeenCalledTimes(2)
    second.release()
    mod.invalidateOpenCodeSkillInventory()
    expect(mod.hasActiveOpenCodeTask()).toBe(false)
    second.stop()
  })
  it('will not copy history from a running task', async () => {
    const mod = await import('../process')
    vi.spyOn(mod.OpenCodeProcess.prototype, 'start').mockResolvedValue()
    const runtime = await mod.getOpenCodeProcess('source', '/workspace', {}, [], new AbortController().signal)
    await expect(mod.copyOpenCodeHistory('source', 'target')).rejects.toThrow('Stop')
    expect(mocks.cp).not.toHaveBeenCalled()
    runtime.release()
    runtime.stop()
  })
  it('waits for the source process to exit before copying durable data and does not overwrite a target', async () => {
    const mod = await import('../process')
    vi.spyOn(mod.OpenCodeProcess.prototype, 'start').mockResolvedValue()
    const runtime = await mod.getOpenCodeProcess('source', '/workspace', {}, [], new AbortController().signal)
    runtime.release()
    const stop = vi.spyOn(runtime, 'stopAndWait').mockImplementation(async () => {
      runtime.stop()
    })
    await mod.copyOpenCodeHistory('source', 'target')
    expect(stop).toHaveBeenCalledOnce()
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(mocks.cp.mock.invocationCallOrder[0])
    const [source, target, options] = mocks.cp.mock.calls[0]
    expect(source.replaceAll('\\', '/')).toMatch(/^\/owned\/OpenCode\/[a-f0-9]{64}\/data$/)
    expect(target.replaceAll('\\', '/')).toMatch(/^\/owned\/OpenCode\/[a-f0-9]{64}\/data$/)
    expect(options).toEqual({ recursive: true, errorOnExist: true, force: false })
    mocks.mkdir.mockRejectedValueOnce(new Error('EEXIST'))
    await expect(mod.copyOpenCodeHistory('source', 'target')).rejects.toThrow('EEXIST')
    expect(mocks.cp).toHaveBeenCalledOnce()
  })
  it('rejects simultaneous prompts and reuses idle instances', async () => {
    const mod = await import('../process')
    vi.spyOn(mod.OpenCodeProcess.prototype, 'start').mockResolvedValue()
    const onStarting = vi.fn()
    const runtime = await mod.getOpenCodeProcess(
      'session',
      '/workspace',
      {},
      [],
      new AbortController().signal,
      onStarting
    )
    await expect(mod.getOpenCodeProcess('session', '/workspace', {}, [], new AbortController().signal)).rejects.toThrow(
      'active task'
    )
    await expect(
      mod.getOpenCodeProcess('session', '/workspace', {}, [], new AbortController().signal)
    ).rejects.toMatchObject({
      name: 'OpenCodeSessionBusyError',
      zenFailureStage: 'runtime-startup',
      zenRuntimeId: 'opencode'
    })
    runtime.release()
    expect(
      await mod.getOpenCodeProcess('session', '/workspace', {}, [], new AbortController().signal, onStarting)
    ).toBe(runtime)
    expect(onStarting).toHaveBeenCalledOnce()
    runtime.release()
    runtime.stop()
  })
  it('keeps a cancelled startup out of the process pool', async () => {
    const mod = await import('../process')
    const start = vi.spyOn(mod.OpenCodeProcess.prototype, 'start').mockResolvedValue()
    const controller = new AbortController()
    controller.abort('cancelled')
    await expect(mod.getOpenCodeProcess('session', '/workspace', {}, [], controller.signal)).rejects.toBe('cancelled')
    expect(start).not.toHaveBeenCalled()
  })
  it('restarts for changed model/key configuration without deleting history', async () => {
    const mod = await import('../process')
    vi.spyOn(mod.OpenCodeProcess.prototype, 'start').mockResolvedValue()
    const old = await mod.getOpenCodeProcess(
      'session',
      '/workspace',
      { model: 'one' },
      [],
      new AbortController().signal
    )
    old.release()
    const next = await mod.getOpenCodeProcess(
      'session',
      '/workspace',
      { model: 'two' },
      [],
      new AbortController().signal
    )
    expect(next).not.toBe(old)
    expect(mocks.rename).not.toHaveBeenCalled()
    next.release()
    next.stop()
  })
  it('does not clear an active native conversation', async () => {
    const mod = await import('../process')
    vi.spyOn(mod.OpenCodeProcess.prototype, 'start').mockResolvedValue()
    const runtime = await mod.getOpenCodeProcess('session', '/workspace', {}, [], new AbortController().signal)
    await expect(mod.archiveOpenCodeSession('session')).rejects.toThrow('Stop')
    expect(mocks.rename).not.toHaveBeenCalled()
    runtime.release()
    runtime.stop()
  })
  it('archives only hashed descendants of the owned data directory', async () => {
    const mod = await import('../process')
    await mod.archiveOpenCodeSession('../../user-files')
    const [source, destination] = mocks.rename.mock.calls[0].map((value: string) => value.replaceAll('\\', '/'))
    expect(source).toMatch(/^\/owned\/OpenCode\/[a-f0-9]{64}$/)
    expect(destination).toMatch(/^\/owned\/OpenCode\/archived-[a-f0-9]{64}-[a-f0-9-]+$/)
  })
  it('holds the lease while display history is reset', async () => {
    const mod = await import('../process')
    let finish!: () => void
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const reset = mod.archiveOpenCodeSession('session', async () => {
      entered()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    await ready
    await expect(mod.getOpenCodeProcess('session', '/workspace', {}, [], new AbortController().signal)).rejects.toThrow(
      'active task'
    )
    finish()
    await reset
  })
  it('restores native history if display-history cleanup fails', async () => {
    const mod = await import('../process')
    await expect(
      mod.archiveOpenCodeSession('session', async () => {
        throw new Error('database unavailable')
      })
    ).rejects.toThrow('database unavailable')
    const [source, archive] = mocks.rename.mock.calls[0]
    expect(mocks.rename).toHaveBeenNthCalledWith(2, archive, source)
  })
})
