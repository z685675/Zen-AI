import { EventEmitter } from 'node:events'
import type * as FsPromises from 'node:fs/promises'
import type * as Os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { HOTPATCH_IPC } from '@shared/hotpatch'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { base, makeArtifact } from './fixtures'
vi.mock('i18next', () => ({ t: (key: string) => key }))

const mocks = vi.hoisted(() => ({
  enabled: true,
  descriptor: '',
  handlers: new Map<string, (...args: any[]) => any>(),
  events: new Map<string, (...args: any[]) => any>(),
  handle: vi.fn(),
  fetch: vi.fn(),
  select: vi.fn(),
  check: vi.fn(),
  healthy: vi.fn(),
  failure: vi.fn(),
  disable: vi.fn(),
  enable: vi.fn(),
  save: vi.fn(async (): Promise<Electron.SaveDialogReturnValue> => ({ canceled: true, filePath: '' })),
  windows: [] as any[]
}))
vi.mock('../trust', () => ({
  get HOTPATCH_PRODUCTION_ENABLED() {
    return mocks.enabled
  },
  HOTPATCH_PRODUCTION_TRUST: { test: 'public-only-test-root' },
  HOTPATCH_POLICY_URL: 'https://zenai.925636.xyz/api/client/patch-policy',
  HOTPATCH_DOWNLOAD_PREFIX: 'https://download.925636.xyz/zen-ai/hotpatch/'
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  lstat: async () => ({ size: 100, isFile: () => true }),
  readFile: async () => mocks.descriptor
}))
vi.mock('../../ConfigManager', () => ({ configManager: { getAutoUpdate: () => true } }))
vi.mock('../engine', () => ({
  HotpatchEngine: class {
    select = mocks.select
    check = mocks.check
  }
}))
vi.mock('../repository', () => ({ SnapshotRepository: class {} }))
vi.mock('../state', () => ({
  HotpatchStateStore: {
    load: async () => ({
      root: 'C:/isolated-hotpatch-test/state',
      snapshot: {
        highestSequence: 2,
        pending: null,
        disabledByUser: false,
        seed: 'not-exported-seed',
        policyBytes: 'not-exported-policy'
      },
      healthy: mocks.healthy,
      failStartup: mocks.failure,
      disable: mocks.disable,
      enable: mocks.enable
    })
  }
}))
vi.mock('electron', () => ({
  dialog: { showSaveDialog: mocks.save, showErrorBox: vi.fn() },
  app: {
    isPackaged: true,
    getVersion: () => '1.2.0',
    getPath: () => 'C:/isolated-hotpatch-test',
    once: (name: string, callback: (...args: any[]) => any) => mocks.events.set(name, callback),
    quit: vi.fn(),
    relaunch: vi.fn()
  },
  ipcMain: { handle: (key: string, handler: (...args: any[]) => any) => mocks.handlers.set(key, handler) },
  session: { fromPartition: () => ({ fetch: mocks.fetch }), defaultSession: { protocol: { handle: mocks.handle } } },
  net: { fetch: mocks.fetch },
  BrowserWindow: class {
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() })
    loadURL = vi.fn()
    show = vi.fn()
    isDestroyed = () => false
    constructor() {
      mocks.windows.push(this)
    }
  }
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.events.clear()
  mocks.windows.length = 0
  mocks.enabled = true
  const exact = { ...base, platform: process.platform, arch: process.arch }
  mocks.descriptor = JSON.stringify({
    schemaVersion: 1,
    bases: [exact],
    builtin: makeArtifact().files,
    frozenSources: {},
    sourceClean: true
  })
  mocks.select.mockResolvedValue({
    snapshot: { root: 'C:/isolated-patch', artifact: makeArtifact() },
    challenge: 'secret-startup-challenge'
  })
  mocks.healthy.mockResolvedValue(true)
  mocks.failure.mockResolvedValue(null)
})
afterEach(() => {
  vi.useRealTimers()
})
async function setup() {
  const { HotpatchService } = await import('../service'),
    service = new HotpatchService()
  await service.prepare()
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url: pathToFileURL(path.join(service.originalRoot, 'index.html')).href }
  })
  const window = { isDestroyed: () => false, webContents: contents } as any
  service.bindWindow(window)
  return { service, window, event: { sender: contents, senderFrame: contents.mainFrame } }
}

describe('base-owned startup coordinator and trusted IPC', () => {
  it('does not enable delivery or make network requests without production capability', async () => {
    mocks.enabled = false
    const { service } = await setup()
    expect(service.status.enabled).toBe(false)
    expect(await service.startupReady).toBe(true)
    await service.check()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.select).not.toHaveBeenCalled()
    service.stop()
  })
  it('requires the exact main window, main frame and bundled URL, and a matching startup challenge', async () => {
    const { service, event } = await setup(),
      status = mocks.handlers.get(HOTPATCH_IPC.status)!,
      healthy = mocks.handlers.get(HOTPATCH_IPC.healthy)!
    expect(() => status({ ...event, sender: {} })).toThrow('sender')
    expect(() => status({ ...event, senderFrame: { ...event.senderFrame } })).toThrow('sender')
    event.senderFrame.url = 'https://untrusted.example/index.html'
    expect(() => status(event)).toThrow('sender')
    event.senderFrame.url = pathToFileURL(path.join(service.originalRoot, 'index.html')).href
    expect(await healthy(event, 'wrong')).toBe(false)
    expect(mocks.healthy).not.toHaveBeenCalled()
    expect(await healthy(event, 'secret-startup-challenge')).toBe(true)
    expect(await service.startupReady).toBe(true)
    expect(service.status.startup).toBe('healthy')
    await vi.advanceTimersByTimeAsync(30000)
    expect(mocks.check).toHaveBeenCalledTimes(1)
    service.stop()
  })
  it('times out only startup readiness, opens an isolated base rescue page and does not replay tasks', async () => {
    const { service } = await setup()
    expect(service.guardingStartup).toBe(true)
    await vi.advanceTimersByTimeAsync(120000)
    expect(mocks.failure).toHaveBeenCalledWith('startup-timeout')
    expect(await service.startupReady).toBe(false)
    expect(service.status.status).toBe('recovering')
    expect(mocks.windows).toHaveLength(1)
    expect(decodeURIComponent(mocks.windows[0].loadURL.mock.calls[0][0])).toContain("default-src 'none'")
    const prevented = vi.fn()
    mocks.windows[0].webContents.emit('will-navigate', { preventDefault: prevented }, 'zen-hotpatch-rescue://export')
    await Promise.resolve()
    expect(prevented).toHaveBeenCalledOnce()
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(mocks.check).not.toHaveBeenCalled()
    service.stop()
  })
  it('does not misclassify a later model/tool error or ordinary time passage as a broken patch', async () => {
    const { service, event } = await setup()
    await mocks.handlers.get(HOTPATCH_IPC.healthy)!(event, 'secret-startup-challenge')
    await service.failStartup('model-503')
    await vi.advanceTimersByTimeAsync(120000)
    expect(mocks.failure).not.toHaveBeenCalled()
    expect(mocks.windows).toHaveLength(0)
    service.stop()
  })
  it('can still restart in safe mode when persisting the recovery opt-out fails', async () => {
    const { app } = await import('electron')
    const { service } = await setup()
    await service.failStartup('entry-load-failed')
    mocks.disable.mockRejectedValueOnce(new Error('disk full'))
    const prevented = vi.fn()
    mocks.windows[0].webContents.emit('will-navigate', { preventDefault: prevented }, 'zen-hotpatch-rescue://restart')
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())
    expect(prevented).toHaveBeenCalledOnce()
    expect(app.relaunch).toHaveBeenCalledWith({
      args: [...process.argv.slice(1).filter((arg) => arg !== '--zen-safe-mode'), '--zen-safe-mode']
    })
    expect(mocks.check).not.toHaveBeenCalled()
    service.stop()
  })
  it('does not reschedule after quitting while a background check is still resolving', async () => {
    const { service, event } = await setup()
    let finish!: () => void
    mocks.check.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    await mocks.handlers.get(HOTPATCH_IPC.healthy)!(event, 'secret-startup-challenge')
    await vi.advanceTimersByTimeAsync(30000)
    service.stop()
    finish()
    await vi.advanceTimersByTimeAsync(3600000)
    expect(mocks.check).toHaveBeenCalledTimes(1)
  })
  it('allows an explicit resume after opting out', async () => {
    const { service, event } = await setup()
    await mocks.handlers.get(HOTPATCH_IPC.healthy)!(event, 'secret-startup-challenge')
    await mocks.handlers.get(HOTPATCH_IPC.disable)!(event)
    await vi.advanceTimersByTimeAsync(30000)
    expect(mocks.check).not.toHaveBeenCalled()
    await mocks.handlers.get(HOTPATCH_IPC.enable)!(event)
    expect(mocks.enable).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30000)
    expect(mocks.check).toHaveBeenCalledOnce()
    service.stop()
  })
  it('does not reactivate a failed startup through the ordinary resume action', async () => {
    const { service, event } = await setup()
    await service.failStartup('entry-load-failed')
    await mocks.handlers.get(HOTPATCH_IPC.enable)!(event)
    expect(mocks.enable).not.toHaveBeenCalled()
    expect(service.status.startup).toBe('failed')
    service.stop()
  })
  it('exports a minimal recovery ZIP without the renderer, policy payload or rollout seed', async () => {
    const fs = await vi.importActual<typeof FsPromises>('node:fs/promises')
    const os = await vi.importActual<typeof Os>('node:os')
    const { default: AdmZip } = await import('adm-zip')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-hotpatch-rescue-'))
    const filePath = path.join(root, 'startup.zip')
    const { service } = await setup()
    try {
      await service.failStartup('entry-load-failed')
      mocks.save.mockResolvedValueOnce({ canceled: false, filePath })
      mocks.windows[0].webContents.emit('will-navigate', { preventDefault: vi.fn() }, 'zen-hotpatch-rescue://export')
      await vi.waitFor(async () => {
        const bytes = await fs.readFile(filePath)
        const zip = new AdmZip(bytes)
        expect(zip.getEntries().map((entry) => entry.entryName)).toEqual(['startup.json'])
        const content = zip.readAsText('startup.json')
        expect(JSON.parse(content).status.startup).toBe('failed')
        expect(content).not.toContain('not-exported-seed')
        expect(content).not.toContain('not-exported-policy')
      })
    } finally {
      service.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
