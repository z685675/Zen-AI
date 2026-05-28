import { loggerService } from '@logger'
import { isPortable } from '@main/constant'
import { configManager } from '@main/services/ConfigManager'
import { APP_NAME, APP_UPDATE_FEED_URL } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { app, type BrowserWindow } from 'electron'
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'
import { autoUpdater } from 'electron-updater'
import semver from 'semver'

export type AppUpdateCheckSource = 'auto' | 'manual'

export interface AppUpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
}

export interface AppUpdateProgressInfo {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface AppUpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error'
  source: AppUpdateCheckSource
  autoUpdateEnabled: boolean
  currentVersion: string
  updateInfo: AppUpdateInfo | null
  progress: AppUpdateProgressInfo | null
  latestVersion?: string
  message?: string
}

function normalizeReleaseDate(value: unknown): string | undefined {
  if (!value) {
    return undefined
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
  }

  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
  }

  if (typeof value === 'object' && 'toISOString' in (value as Record<string, unknown>)) {
    const maybeDate = value as { toISOString?: () => string }
    if (typeof maybeDate.toISOString === 'function') {
      try {
        return maybeDate.toISOString()
      } catch {
        return String(value)
      }
    }
  }

  return String(value)
}

export interface AppUpdateCheckResultAvailable {
  status: 'available'
  currentVersion: string
  source: AppUpdateCheckSource
  updateInfo: AppUpdateInfo
}

export interface AppUpdateCheckResultUpToDate {
  status: 'up-to-date'
  currentVersion: string
  source: AppUpdateCheckSource
  updateInfo: null
  latestVersion?: string
}

export interface AppUpdateCheckResultDownloading {
  status: 'downloading'
  currentVersion: string
  source: AppUpdateCheckSource
  updateInfo: AppUpdateInfo | null
}

export interface AppUpdateCheckResultDownloaded {
  status: 'downloaded'
  currentVersion: string
  source: AppUpdateCheckSource
  updateInfo: AppUpdateInfo
}

export interface AppUpdateCheckResultError {
  status: 'error'
  currentVersion: string
  source: AppUpdateCheckSource
  updateInfo: null
  message: string
}

export type AppUpdateInstallResult =
  | { success: true; status: 'installing'; updateInfo: AppUpdateInfo }
  | { success: false; status: 'not-downloaded' | 'error'; message: string; updateInfo: AppUpdateInfo | null }

export type AppUpdateCheckResult =
  | AppUpdateCheckResultAvailable
  | AppUpdateCheckResultUpToDate
  | AppUpdateCheckResultDownloading
  | AppUpdateCheckResultDownloaded
  | AppUpdateCheckResultError

const logger = loggerService.withContext('AppUpdateService')
const STARTUP_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export class AppUpdateService {
  private readonly feedUrl = APP_UPDATE_FEED_URL.trim()
  private latestUpdateInfo: AppUpdateInfo | null = null
  private downloadedUpdateInfo: AppUpdateInfo | null = null
  private progressInfo: AppUpdateProgressInfo | null = null
  private checking = false
  private downloading = false
  private startupTimeout: NodeJS.Timeout | null = null
  private periodicTimer: NodeJS.Timeout | null = null
  private currentSource: AppUpdateCheckSource = 'auto'
  private currentState: AppUpdateState

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly currentVersion: string,
    private readonly shouldAutoDownload: () => boolean
  ) {
    this.downloadedUpdateInfo = this.restorePendingUpdateInfo()
    this.currentState = {
      status: this.downloadedUpdateInfo ? 'downloaded' : 'idle',
      source: 'auto',
      autoUpdateEnabled: this.shouldAutoDownload(),
      currentVersion: this.currentVersion,
      updateInfo: this.downloadedUpdateInfo,
      progress: null
    }
    this.configureUpdater()
    this.registerUpdaterEvents()
  }

  scheduleStartupCheck(delayMs = 5000) {
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout)
    }

    if (this.periodicTimer) {
      clearInterval(this.periodicTimer)
    }

    const runAutoCheck = () => {
      if (!this.shouldAutoDownload()) {
        return
      }

      void this.checkForUpdates('auto')
    }

    this.startupTimeout = setTimeout(runAutoCheck, delayMs)
    this.periodicTimer = setInterval(runAutoCheck, STARTUP_CHECK_INTERVAL_MS)
  }

  async checkForUpdates(source: AppUpdateCheckSource = 'manual'): Promise<AppUpdateCheckResult> {
    this.currentSource = source
    autoUpdater.autoDownload = source === 'manual' ? false : this.shouldAutoDownload()
    this.setState({
      status: 'checking',
      source,
      autoUpdateEnabled: this.shouldAutoDownload(),
      currentVersion: this.currentVersion,
      updateInfo: this.downloadedUpdateInfo ?? this.latestUpdateInfo,
      progress: this.progressInfo
    })

    if (!app.isPackaged) {
      return this.handleUpdateError(source, `${APP_NAME} only supports auto update after installation packaging.`)
    }

    if (isPortable) {
      return this.handleUpdateError(
        source,
        'Portable builds do not support automatic in-place updates. Please use the installer build.'
      )
    }

    if (this.downloadedUpdateInfo) {
      this.setState({
        status: 'downloaded',
        source,
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo: this.downloadedUpdateInfo,
        progress: null
      })
      return {
        status: 'downloaded',
        currentVersion: this.currentVersion,
        source,
        updateInfo: this.downloadedUpdateInfo
      }
    }

    if (this.downloading) {
      this.setState({
        status: 'downloading',
        source,
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo: this.latestUpdateInfo,
        progress: this.progressInfo
      })
      return {
        status: 'downloading',
        currentVersion: this.currentVersion,
        source,
        updateInfo: this.latestUpdateInfo
      }
    }

    if (this.checking) {
      return this.latestUpdateInfo
        ? {
            status: 'available',
            currentVersion: this.currentVersion,
            source,
            updateInfo: this.latestUpdateInfo
          }
        : {
            status: 'downloading',
            currentVersion: this.currentVersion,
            source,
            updateInfo: this.latestUpdateInfo
          }
    }

    try {
      this.checking = true
      const result = await autoUpdater.checkForUpdates()
      const updateInfo = this.normalizeUpdateInfo(result?.updateInfo)

      if (!result?.isUpdateAvailable) {
        this.latestUpdateInfo = null
        this.progressInfo = null
        this.setState({
          status: 'up-to-date',
          source,
          autoUpdateEnabled: this.shouldAutoDownload(),
          currentVersion: this.currentVersion,
          updateInfo: null,
          progress: null,
          latestVersion: updateInfo.version
        })
        return {
          status: 'up-to-date',
          currentVersion: this.currentVersion,
          source,
          updateInfo: null,
          latestVersion: updateInfo.version
        }
      }

      this.latestUpdateInfo = updateInfo
      this.setState({
        status: 'available',
        source,
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo,
        progress: null
      })

      return {
        status: 'available',
        currentVersion: this.currentVersion,
        source,
        updateInfo
      }
    } catch (error) {
      return this.handleUpdateError(source, error instanceof Error ? error.message : String(error))
    } finally {
      this.checking = false
    }
  }

  async downloadUpdate(): Promise<AppUpdateCheckResult> {
    this.currentSource = 'manual'
    autoUpdater.autoDownload = false

    if (!app.isPackaged) {
      return this.handleUpdateError('manual', `${APP_NAME} only supports auto update after installation packaging.`)
    }

    if (isPortable) {
      return this.handleUpdateError(
        'manual',
        'Portable builds do not support automatic in-place updates. Please use the installer build.'
      )
    }

    if (this.downloadedUpdateInfo) {
      this.setState({
        status: 'downloaded',
        source: 'manual',
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo: this.downloadedUpdateInfo,
        progress: null
      })
      return {
        status: 'downloaded',
        currentVersion: this.currentVersion,
        source: 'manual',
        updateInfo: this.downloadedUpdateInfo
      }
    }

    if (this.downloading) {
      this.setState({
        status: 'downloading',
        source: 'manual',
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo: this.latestUpdateInfo,
        progress: this.progressInfo
      })
      return {
        status: 'downloading',
        currentVersion: this.currentVersion,
        source: 'manual',
        updateInfo: this.latestUpdateInfo
      }
    }

    if (!this.latestUpdateInfo) {
      const result = await this.checkForUpdates('manual')
      if (result.status !== 'available') {
        return result
      }
    }

    try {
      this.downloading = true
      this.setState({
        status: 'downloading',
        source: 'manual',
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo: this.latestUpdateInfo,
        progress: this.progressInfo
      })
      autoUpdater.autoDownload = true
      await autoUpdater.downloadUpdate()

      return {
        status: 'downloading',
        currentVersion: this.currentVersion,
        source: 'manual',
        updateInfo: this.latestUpdateInfo
      }
    } catch (error) {
      this.downloading = false
      return this.handleUpdateError('manual', error instanceof Error ? error.message : String(error))
    }
  }

  quitAndInstall(): AppUpdateInstallResult {
    const updateInfo = this.downloadedUpdateInfo ?? this.restorePendingUpdateInfo()

    if (!updateInfo) {
      const message = 'Update package has not been downloaded yet.'
      logger.warn('Cannot install update because no downloaded update is available')
      return {
        success: false,
        status: 'not-downloaded',
        message,
        updateInfo: null
      }
    }

    this.downloadedUpdateInfo = updateInfo
    this.latestUpdateInfo = updateInfo
    this.progressInfo = null
    this.setState({
      status: 'downloaded',
      source: this.currentSource,
      autoUpdateEnabled: this.shouldAutoDownload(),
      currentVersion: this.currentVersion,
      updateInfo,
      progress: null
    })

    try {
      app.isInstallingUpdate = true
      app.isQuitting = true
      logger.info('Quitting and installing downloaded app update', { version: updateInfo.version })
      autoUpdater.quitAndInstall(false, true)
      this.clearPendingUpdateInfo()
      return {
        success: true,
        status: 'installing',
        updateInfo
      }
    } catch (error) {
      app.isInstallingUpdate = false
      app.isQuitting = false
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to quit and install downloaded update', { error: message })
      return {
        success: false,
        status: 'error',
        message,
        updateInfo
      }
    }
  }

  getState(): AppUpdateState {
    return {
      ...this.currentState,
      autoUpdateEnabled: this.shouldAutoDownload()
    }
  }

  private configureUpdater() {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    autoUpdater.logger = {
      info: (message?: unknown) => logger.info(String(message ?? '')),
      warn: (message?: unknown) => logger.warn(String(message ?? '')),
      error: (message?: unknown) => logger.error(String(message ?? '')),
      debug: (message?: string) => logger.debug(message ?? '')
    }

    if (this.feedUrl) {
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: this.feedUrl,
        channel: 'latest'
      })
    }
  }

  private registerUpdaterEvents() {
    autoUpdater.on('update-available', (info) => {
      const updateInfo = this.normalizeUpdateInfo(info)
      this.latestUpdateInfo = updateInfo
      this.downloading = autoUpdater.autoDownload
      this.progressInfo = null
      this.setState({
        status: autoUpdater.autoDownload ? 'downloading' : 'available',
        source: this.currentSource,
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo,
        progress: this.progressInfo
      })

      const payload = { ...updateInfo, currentVersion: this.currentVersion, source: this.currentSource }
      this.sendEvent(IpcChannel.UpdateAvailable, payload)
      logger.info('App update available', { ...payload, autoDownload: autoUpdater.autoDownload })
    })

    autoUpdater.on('update-not-available', (info) => {
      this.latestUpdateInfo = null
      this.progressInfo = null
      this.setState({
        status: 'up-to-date',
        source: this.currentSource,
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo: null,
        progress: null,
        latestVersion: this.normalizeUpdateInfo(info).version
      })
      const payload = {
        currentVersion: this.currentVersion,
        source: this.currentSource,
        latestVersion: this.normalizeUpdateInfo(info).version
      }
      this.sendEvent(IpcChannel.UpdateNotAvailable, payload)
      logger.info('App already up to date', payload)
    })

    autoUpdater.on('download-progress', (progress) => {
      this.downloading = true
      this.progressInfo = this.normalizeProgressInfo(progress)
      this.setState({
        status: 'downloading',
        source: this.currentSource,
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo: this.latestUpdateInfo,
        progress: this.progressInfo
      })
      this.sendEvent(IpcChannel.DownloadProgress, this.progressInfo)
    })

    autoUpdater.on('update-downloaded', (event) => {
      this.downloading = false
      const updateInfo = this.normalizeUpdateInfo(event)
      this.latestUpdateInfo = updateInfo
      this.downloadedUpdateInfo = updateInfo
      this.progressInfo = null
      this.persistPendingUpdateInfo(updateInfo)
      this.setState({
        status: 'downloaded',
        source: this.currentSource,
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo,
        progress: null
      })

      const payload = { ...updateInfo, currentVersion: this.currentVersion, source: this.currentSource }
      this.sendEvent(IpcChannel.UpdateDownloaded, payload)
      logger.info('App update downloaded', payload)
    })

    autoUpdater.on('error', (error) => {
      this.checking = false
      this.downloading = false
      this.progressInfo = null
      this.handleUpdateError(this.currentSource, error instanceof Error ? error.message : String(error))
    })
  }

  private handleUpdateError(source: AppUpdateCheckSource, message: string): AppUpdateCheckResultError {
    this.setState({
      status: 'error',
      source,
      autoUpdateEnabled: this.shouldAutoDownload(),
      currentVersion: this.currentVersion,
      updateInfo: this.downloadedUpdateInfo ?? this.latestUpdateInfo,
      progress: null,
      message
    })
    const payload = {
      currentVersion: this.currentVersion,
      source,
      message
    }
    this.sendEvent(IpcChannel.UpdateError, payload)
    logger.warn('App update check failed', payload)

    return {
      status: 'error',
      currentVersion: this.currentVersion,
      source,
      updateInfo: null,
      message
    }
  }

  private normalizeUpdateInfo(info: UpdateInfo | UpdateDownloadedEvent | undefined): AppUpdateInfo {
    const releaseNotes = Array.isArray(info?.releaseNotes)
      ? info.releaseNotes
          .map((note) => note.note)
          .filter(Boolean)
          .join('\n')
      : (info?.releaseNotes ?? undefined)

    return {
      version: info?.version ?? this.currentVersion,
      releaseDate: normalizeReleaseDate(info?.releaseDate),
      releaseNotes: releaseNotes ?? undefined
    }
  }

  private normalizeProgressInfo(progress: ProgressInfo) {
    return {
      percent: Math.max(0, Math.min(100, progress.percent)),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    }
  }

  private setState(state: AppUpdateState) {
    this.currentState = state
  }

  private restorePendingUpdateInfo(): AppUpdateInfo | null {
    const pending = configManager.getPendingUpdateInfo<AppUpdateInfo>()

    if (!pending?.version) {
      return null
    }

    const pendingVersion = semver.coerce(pending.version)
    const currentVersion = semver.coerce(this.currentVersion)

    if (!pendingVersion || !currentVersion) {
      return pending
    }

    if (semver.lte(pendingVersion, currentVersion)) {
      this.clearPendingUpdateInfo()
      return null
    }

    return pending
  }

  private persistPendingUpdateInfo(updateInfo: AppUpdateInfo) {
    configManager.setPendingUpdateInfo(updateInfo)
  }

  private clearPendingUpdateInfo() {
    configManager.setPendingUpdateInfo(null)
  }

  private sendEvent(channel: IpcChannel, payload: unknown) {
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload)
    }
  }
}
