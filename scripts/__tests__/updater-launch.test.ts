import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const sdk = path.dirname(require.resolve('electron-updater'))
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

// Run the shipped SDK implementation, replacing only OS process creation and
// Electron. These tests never launch an installer or quit the running app.
function fixture(admin = false) {
  const native = new EventEmitter()
  const quit = vi.fn()
  const children: (EventEmitter & { unref: ReturnType<typeof vi.fn> })[] = []
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    children.push(child)
    return child
  })
  class AppUpdater extends EventEmitter {
    app = { quit }
    _logger = { info() {}, warn() {}, error() {} }
    autoRunAppAfterInstall = true
    dispatchError(error: Error) {
      this.emit('error', error)
    }
  }
  const load = (filename: string, mocks: Record<string, unknown>) => {
    const module = { exports: {} as any }
    vm.runInNewContext(readFileSync(path.join(sdk, filename), 'utf8'), {
      module,
      exports: module.exports,
      process: { ...process, resourcesPath: 'fixture-resources', env: process.env },
      setImmediate,
      require: (name: string) => (name in mocks ? mocks[name] : require(name))
    })
    return module.exports
  }
  const base = load('BaseUpdater.js', {
    './AppUpdater': { AppUpdater },
    child_process: { spawn },
    electron: { autoUpdater: native }
  })
  const { NsisUpdater } = load('NsisUpdater.js', {
    './BaseUpdater': base,
    'builder-util-runtime': {},
    './differentialDownloader/FileWithEmbeddedBlockMapDifferentialDownloader': {},
    './types': {},
    './providers/Provider': {},
    'fs-extra': {},
    './windowsExecutableCodeSignatureVerifier': {}
  })
  const updater = new NsisUpdater()
  updater.downloadedUpdateHelper = {
    file: 'fixture-installer.exe',
    downloadedFileInfo: { isAdminRightsRequired: admin }
  }
  const errors = vi.fn()
  updater.on('error', errors)
  return { updater, children, spawn, quit, errors, native }
}

describe('Windows updater launch confirmation', () => {
  it.each(['EIO', 'ENOENT'])('keeps the app open on %s and launches on the first retry', async (code) => {
    const f = fixture()
    const launch = f.updater.quitAndInstall(false, true)
    expect(f.quit).not.toHaveBeenCalled()
    f.children[0].emit('error', Object.assign(new Error('fixture failure'), { code }))
    await launch
    await tick()
    expect(f.quit).not.toHaveBeenCalled()
    expect(f.errors).toHaveBeenCalledOnce()
    expect(f.updater.quitAndInstallCalled).toBe(false)
    const retry = f.updater.quitAndInstall(false, true)
    expect(f.spawn).toHaveBeenCalledTimes(2)
    f.children[1].emit('spawn')
    await retry
    await tick()
    expect(f.quit).toHaveBeenCalledOnce()
    expect(f.spawn.mock.calls[1][1]).toEqual(['--updated', '--force-run'])
  })

  it('waits for UAC acceptance and permits retry after cancellation', async () => {
    const f = fixture(true)
    const launch = f.updater.quitAndInstall()
    f.children[0].emit('spawn')
    await tick()
    expect(f.quit).not.toHaveBeenCalled()
    f.children[0].emit('close', 1223, null)
    await launch
    expect(f.quit).not.toHaveBeenCalled()
    const retry = f.updater.quitAndInstall()
    f.children[1].emit('spawn')
    f.children[1].emit('close', 0, null)
    await retry
    await tick()
    expect(f.quit).toHaveBeenCalledOnce()
  })

  it('preserves the parent PID for asynchronous elevation fallback', async () => {
    const f = fixture()
    const previous = process.env.ZEN_AI_UPDATE_PARENT_PID
    try {
      process.env.ZEN_AI_UPDATE_PARENT_PID = '12345'
      const launch = f.updater.quitAndInstall()
      delete process.env.ZEN_AI_UPDATE_PARENT_PID
      f.children[0].emit('error', Object.assign(new Error('access denied'), { code: 'EACCES' }))
      await tick()
      expect(f.spawn.mock.calls[1][2].env.ZEN_AI_UPDATE_PARENT_PID).toBe('12345')
      f.children[1].emit('spawn')
      expect(f.quit).not.toHaveBeenCalled()
      f.children[1].emit('close', 0, null)
      await launch
      await tick()
      expect(f.quit).toHaveBeenCalledOnce()
    } finally {
      if (previous === undefined) delete process.env.ZEN_AI_UPDATE_PARENT_PID
      else process.env.ZEN_AI_UPDATE_PARENT_PID = previous
    }
  })
})
