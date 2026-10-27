import { lstat, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { loggerService } from '@logger'
import { HOTPATCH_ENTRIES, HOTPATCH_IPC, HotpatchError, type HotpatchStatus } from '@shared/hotpatch'
import { type HotpatchDescriptor, hotpatchDescriptorSchema } from '@shared/hotpatchBuild'
import AdmZip from 'adm-zip'
import { app, BrowserWindow, dialog, ipcMain, net, session } from 'electron'
import { t } from 'i18next'

import { isPortable } from '../../constant'
import { configManager } from '../ConfigManager'
import { HotpatchEngine } from './engine'
import { SnapshotRepository } from './repository'
import { createSecureFileFallback, createSnapshotResourceHandler } from './resources'
import { HOTPATCH_CSP } from './security'
import { HotpatchStateStore } from './state'
import {
  HOTPATCH_DOWNLOAD_PREFIX,
  HOTPATCH_POLICY_URL,
  HOTPATCH_PRODUCTION_ENABLED,
  HOTPATCH_PRODUCTION_TRUST
} from './trust'

const logger = loggerService.withContext('Hotpatch')
const jitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4))

/** Immutable process selection. This service never reloads a running task or writes installation files. */
export class HotpatchService {
  private engine?: HotpatchEngine
  private store?: HotpatchStateStore
  private descriptor?: HotpatchDescriptor
  private window?: BrowserWindow
  private rescue?: BrowserWindow
  private challenge?: string
  private selectedPatch?: string
  private statusValue: HotpatchStatus = {
    baseVersion: app.getVersion(),
    enabled: false,
    status: 'unavailable',
    startup: 'builtin',
    policySequence: 0
  }
  private timer?: NodeJS.Timeout
  private healthTimer?: NodeJS.Timeout
  private request?: AbortController
  private failures = 0
  private stopped = false
  private resolveStartup!: (ready: boolean) => void
  readonly startupReady = new Promise<boolean>((resolve) => {
    this.resolveStartup = resolve
  })
  readonly originalRoot = path.resolve(__dirname, '../renderer')

  get secure(): boolean {
    return this.statusValue.enabled
  }
  get guardingStartup(): boolean {
    return !!this.challenge && this.statusValue.startup === 'checking'
  }
  get status(): HotpatchStatus {
    const state = this.store?.snapshot
    return {
      ...this.statusValue,
      policySequence: state?.highestSequence ?? 0,
      ...(this.selectedPatch ? { patchId: this.selectedPatch } : {}),
      ...(state?.pending ? { pendingPatchId: state.pending.target?.patchId ?? 'builtin' } : {}),
      ...(state?.lastError ? { lastError: state.lastError } : {})
    }
  }

  async prepare(): Promise<void> {
    this.stopped = false
    this.registerIpc()
    app.once('before-quit', () => this.stop())
    // No runtime environment variable/API response can introduce a signing trust root.
    if (!app.isPackaged || !HOTPATCH_PRODUCTION_ENABLED || !Object.keys(HOTPATCH_PRODUCTION_TRUST).length) {
      this.resolveStartup(true)
      return
    }
    try {
      const filename = path.join(__dirname, 'hotpatch-base.json'),
        stat = await lstat(filename)
      if (stat.size > 4 * 1024 * 1024 || !stat.isFile())
        throw new HotpatchError('compatibility', 'Invalid base descriptor')
      this.descriptor = hotpatchDescriptorSchema.parse(JSON.parse(await readFile(filename, 'utf8')))
      if (!this.descriptor.sourceClean) throw new HotpatchError('compatibility', 'Unreviewed base build')
      const base = this.descriptor.bases.find(
        (item) =>
          item.platform === process.platform &&
          item.arch === process.arch &&
          item.packaging === (isPortable ? 'portable' : 'installed')
      )
      if (!base || base.version !== app.getVersion())
        throw new HotpatchError('compatibility', 'Missing exact base build identity')
      this.statusValue = { ...this.statusValue, enabled: true, status: 'builtin', baseBuildId: base.baseBuildId }
      this.store = await HotpatchStateStore.load(
        path.join(app.getPath('userData'), 'hotpatch', base.baseBuildId),
        base.baseBuildId
      )
      // Separate session: no provider keys, account cookies, authentication callbacks or model headers.
      const transport = session.fromPartition('zen-hotpatch-download')
      const fetcher = (url: string, options: RequestInit) => transport.fetch(url, options)
      const repository = new SnapshotRepository({
        root: path.join(this.store.root, 'snapshots'),
        base,
        builtin: this.descriptor.builtin,
        trust: HOTPATCH_PRODUCTION_TRUST,
        allowed: [HOTPATCH_DOWNLOAD_PREFIX],
        fetcher
      })
      const policyUrl = new URL(HOTPATCH_POLICY_URL)
      policyUrl.searchParams.set('base', base.baseBuildId)
      this.engine = new HotpatchEngine({
        base,
        trust: HOTPATCH_PRODUCTION_TRUST,
        policyUrl: policyUrl.href,
        allowedPolicy: [HOTPATCH_POLICY_URL],
        fetcher,
        repository,
        store: this.store
      })
      const safeMode = process.argv.includes('--zen-safe-mode')
      if (safeMode) await this.store.disable()
      const selection = await this.engine.select(safeMode)
      this.challenge = selection.challenge
      this.selectedPatch = selection.snapshot?.artifact.patchId
      this.statusValue.status = this.store.snapshot.disabledByUser
        ? 'disabled'
        : selection.snapshot
          ? 'active'
          : 'builtin'
      this.statusValue.startup = selection.challenge ? 'checking' : 'builtin'
      const fallback = createSecureFileFallback(this.originalRoot, (request) =>
        net.fetch(request, { bypassCustomProtocolHandlers: true })
      )
      if (selection.snapshot) {
        session.defaultSession.protocol.handle(
          'file',
          createSnapshotResourceHandler({
            originalRoot: this.originalRoot,
            snapshotRoot: selection.snapshot.root,
            files: selection.snapshot.artifact.files,
            fallback,
            securityPolicy: HOTPATCH_CSP,
            onFailure: () => {
              if (this.guardingStartup) void this.failStartup('resource-integrity')
            }
          })
        )
      } else {
        // Establish the same base security profile before any patch is offered.
        session.defaultSession.protocol.handle('file', async (request) => {
          const response = await fallback(request)
          if (
            !HOTPATCH_ENTRIES.some(
              (entry) => request.url.split(/[?#]/)[0] === pathToFileURL(path.join(this.originalRoot, entry)).href
            )
          )
            return response
          const headers = new Headers(response.headers)
          headers.set('Content-Security-Policy', HOTPATCH_CSP)
          return new Response(response.body, { status: response.status, headers })
        })
      }
      if (!this.challenge) this.resolveStartup(true)
    } catch (error) {
      logger.error('Patch preparation failed; keep bundled renderer', error as Error)
      this.statusValue = {
        ...this.statusValue,
        enabled: false,
        status: 'unavailable',
        lastError: { code: error instanceof HotpatchError ? error.code : 'storage', at: Date.now() }
      }
      this.resolveStartup(true)
    }
  }

  bindWindow(window: BrowserWindow): void {
    this.window = window
    if (!this.secure) return
    if (this.challenge) {
      this.healthTimer = setTimeout(() => {
        void this.failStartup('startup-timeout')
      }, 120000)
      this.healthTimer.unref()
      window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
        if (mainFrame && code !== -3 && this.guardingStartup) void this.failStartup('entry-load-failed')
      })
    }
    void this.startupReady.then((ready) => {
      if (ready) this.schedule(30000)
    })
  }

  async failStartup(code: string): Promise<void> {
    if (!this.guardingStartup) return
    this.statusValue.startup = 'failed'
    this.statusValue.status = 'recovering'
    clearTimeout(this.healthTimer)
    this.resolveStartup(false)
    try {
      await this.store?.failStartup(code)
    } catch (error) {
      logger.error('Could not persist patch quarantine', error as Error)
    }
    this.showRescue()
  }

  private trusted(event: Electron.IpcMainInvokeEvent): boolean {
    const expected = app.isPackaged
      ? pathToFileURL(path.join(this.originalRoot, 'index.html')).href
      : process.env.ELECTRON_RENDERER_URL?.replace(/\/$/, '')
    const actual = event.senderFrame?.url.split(/[?#]/)[0].replace(/\/$/, '')
    return (
      !!this.window &&
      !this.window.isDestroyed() &&
      event.sender === this.window.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      !!expected &&
      actual === expected
    )
  }
  private registerIpc(): void {
    const guard = (event: Electron.IpcMainInvokeEvent) => {
      if (!this.trusted(event)) throw new Error('invalid_hotpatch_sender')
    }
    ipcMain.handle(HOTPATCH_IPC.status, (event) => {
      guard(event)
      return this.status
    })
    ipcMain.handle(HOTPATCH_IPC.startup, (event) => {
      guard(event)
      return this.guardingStartup ? this.challenge : null
    })
    ipcMain.handle(HOTPATCH_IPC.healthy, async (event, challenge: unknown) => {
      guard(event)
      if (typeof challenge !== 'string' || !this.guardingStartup || challenge !== this.challenge) return false
      if (!(await this.store?.healthy(challenge))) return false
      clearTimeout(this.healthTimer)
      this.challenge = undefined
      this.statusValue.startup = 'healthy'
      this.resolveStartup(true)
      return true
    })
    ipcMain.handle(HOTPATCH_IPC.check, async (event, testCode: unknown) => {
      guard(event)
      if (testCode !== undefined && (typeof testCode !== 'string' || testCode.length > 256))
        throw new Error('invalid_hotpatch_test_code')
      await this.check(testCode)
      return this.status
    })
    ipcMain.handle(HOTPATCH_IPC.disable, async (event) => {
      guard(event)
      await this.store?.disable()
      this.statusValue.status = 'disabled'
      this.stop()
      return this.status
    })
    ipcMain.handle(HOTPATCH_IPC.enable, async (event) => {
      guard(event)
      if (!this.store || !this.secure || this.statusValue.startup === 'failed') return this.status
      await this.store.enable()
      this.stopped = false
      this.statusValue.status = this.selectedPatch ? 'active' : 'builtin'
      this.schedule(30000)
      return this.status
    })
  }

  async check(testCode?: string): Promise<void> {
    if (
      !this.engine ||
      !this.secure ||
      this.stopped ||
      this.store?.snapshot.disabledByUser ||
      !configManager.getAutoUpdate() ||
      this.request
    )
      return
    this.request = new AbortController()
    const deadline = setTimeout(() => this.request?.abort(), 180000)
    try {
      this.statusValue.status = 'checking'
      await this.engine.check(this.request.signal, testCode)
      this.failures = 0
      if (!this.stopped)
        this.statusValue.status = this.store?.snapshot.pending ? 'pending' : this.selectedPatch ? 'active' : 'builtin'
    } catch (error) {
      const code = error instanceof HotpatchError ? error.code : 'network'
      logger.warn('Background patch check failed', { code }) // No raw URLs, credentials, user text or signature payload in logs.
      this.failures++
      this.statusValue.lastError = { code, at: Date.now() }
      if (!this.stopped) this.statusValue.status = this.selectedPatch ? 'active' : 'builtin'
    } finally {
      clearTimeout(deadline)
      this.request = undefined
    }
  }
  private schedule(delay: number): void {
    if (this.stopped || this.store?.snapshot.disabledByUser) return
    clearTimeout(this.timer)
    this.timer = setTimeout(async () => {
      await this.check()
      const retry = [60000, 300000, 900000, 3600000]
      this.schedule(jitter(this.failures ? retry[Math.min(this.failures - 1, retry.length - 1)] : 900000))
    }, delay)
    this.timer.unref()
  }
  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.healthTimer)
    this.request?.abort()
  }

  private async exportStartupDiagnostic(): Promise<void> {
    if (!this.rescue || this.rescue.isDestroyed()) return
    try {
      const choice = await dialog.showSaveDialog(this.rescue, {
        title: t('hotpatch.rescue.export'),
        defaultPath: `zen-ai-startup-${Date.now()}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }]
      })
      if (choice.canceled || !choice.filePath) return
      const state = this.store?.snapshot
      const archive = new AdmZip()
      // Independent of the renderer, model/provider configuration, history DB and task exporters.
      archive.addFile(
        'startup.json',
        Buffer.from(
          JSON.stringify(
            {
              schemaVersion: 1,
              exportedAt: new Date().toISOString(),
              platform: process.platform,
              arch: process.arch,
              status: this.status,
              recovery: state
                ? {
                    active: state.active,
                    lastGood: state.lastGood,
                    previousGood: state.previousGood,
                    quarantined: state.quarantined,
                    recoveryRequired: state.recoveryRequired
                  }
                : null
            },
            null,
            2
          )
        )
      )
      const file = await open(choice.filePath, 'wx', 0o600)
      try {
        await file.writeFile(archive.toBuffer())
        await file.sync()
      } finally {
        await file.close()
      }
    } catch {
      logger.warn('Could not export local startup diagnostic')
      dialog.showErrorBox(t('hotpatch.rescue.title'), t('hotpatch.rescue.exportFailed'))
    }
  }

  private async restartInSafeMode(): Promise<void> {
    try {
      await this.store?.disable()
    } catch {
      // Recovery must also work when the failed write is the reason the renderer could not start.
      // The relaunch argument selects the builtin UI even if the opt-out cannot be persisted.
      logger.warn('Could not persist patch opt-out before safe-mode restart')
    }
    app.relaunch({
      args: [...process.argv.slice(1).filter((arg) => arg !== '--zen-safe-mode'), '--zen-safe-mode']
    })
    app.quit()
  }

  private showRescue(): void {
    if (this.rescue && !this.rescue.isDestroyed()) {
      this.rescue.show()
      return
    }
    this.rescue = new BrowserWindow({
      width: 640,
      height: 430,
      resizable: false,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true }
    })
    const escape = (value: string) => String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
    const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:16px system-ui;padding:30px;line-height:1.7}a{display:inline-block;padding:8px 16px;margin:4px;background:#157347;color:white;border-radius:6px;text-decoration:none}</style><h2>${escape(t('hotpatch.rescue.title'))}</h2><p>${escape(t('hotpatch.rescue.description'))}</p><a href="zen-hotpatch-rescue://restart">${escape(t('hotpatch.rescue.restart'))}</a><a href="zen-hotpatch-rescue://export">${escape(t('hotpatch.rescue.export'))}</a>`
    this.rescue.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.rescue.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (url === 'zen-hotpatch-rescue://export') void this.exportStartupDiagnostic()
      if (url === 'zen-hotpatch-rescue://restart') {
        // Explicit user action, through normal quit guards/cleanup. Never replay the failed task.
        void this.restartInSafeMode()
      }
    })
    void this.rescue.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  }
}
export const hotpatchService = new HotpatchService()
