import { loggerService } from '@logger'
import { isPortable } from '@main/constant'
import { APP_NAME, APP_UPDATE_FEED_URL } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { type BrowserWindow, app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'

export type AppUpdateCheckSource = 'auto' | 'manual'

export interface AppUpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
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
  private checking = false
  private downloading = false
  private startupTimer: NodeJS.Timeout | null = null
  private currentSource: AppUpdateCheckSource = 'auto'

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly currentVersion: string,
    private readonly shouldAutoDownload: () => boolean
  ) {
    this.configureUpdater()
    this.registerUpdaterEvents()
  }

  scheduleStartupCheck(delayMs = 5000) {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
    }

    this.startupTimer = setTimeout(() => {
      void this.checkForUpdates('auto')
      this.startupTimer = setInterval(() => {
        void this.checkForUpdates('auto')
      }, STARTUP_CHECK_INTERVAL_MS)
    }, delayMs)
  }

  async checkForUpdates(source: AppUpdateCheckSource = 'manual'): Promise<AppUpdateCheckResult> {
    this.currentSource = source
    autoUpdater.autoDownload = source === 'manual' ? true : this.shouldAutoDownload()

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
      return {
        status: 'downloaded',
        currentVersion: this.currentVersion,
        source,
        updateInfo: this.downloadedUpdateInfo
      }
    }

    if (this.downloading) {
      return {
        status: 'downloading',
        currentVersion: this.currentVersion,
        source,
        updateInfo: this.latestUpdateInfo
      }
    }

    if (this.checking) {
      return {
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
        return {
          status: 'up-to-date',
          currentVersion: this.currentVersion,
          source,
          updateInfo: null,
          latestVersion: updateInfo.version
        }
      }

      this.latestUpdateInfo = updateInfo

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

  quitAndInstall() {
    if (!this.downloadedUpdateInfo) {
      return false
    }

    autoUpdater.quitAndInstall(false, true)
    return true
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

      const payload = { ...updateInfo, currentVersion: this.currentVersion, source: this.currentSource }
      this.sendEvent(IpcChannel.UpdateAvailable, payload)
      logger.info('App update available', { ...payload, autoDownload: autoUpdater.autoDownload })
    })

    autoUpdater.on('update-not-available', (info) => {
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
      this.sendEvent(IpcChannel.DownloadProgress, this.normalizeProgressInfo(progress))
    })

    autoUpdater.on('update-downloaded', (event) => {
      this.downloading = false
      const updateInfo = this.normalizeUpdateInfo(event)
      this.latestUpdateInfo = updateInfo
      this.downloadedUpdateInfo = updateInfo

      const payload = { ...updateInfo, currentVersion: this.currentVersion, source: this.currentSource }
      this.sendEvent(IpcChannel.UpdateDownloaded, payload)
      logger.info('App update downloaded', payload)
    })

    autoUpdater.on('error', (error) => {
      this.checking = false
      this.downloading = false
      this.handleUpdateError(this.currentSource, error instanceof Error ? error.message : String(error))
    })
  }

  private handleUpdateError(source: AppUpdateCheckSource, message: string): AppUpdateCheckResultError {
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
      releaseDate: info?.releaseDate,
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

  private sendEvent(channel: IpcChannel, payload: unknown) {
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload)
    }
  }
}
