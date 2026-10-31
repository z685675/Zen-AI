import { createWriteStream, statSync } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { request } from 'node:https'
import path from 'node:path'

import { loggerService } from '@logger'
import { isMac, isPortable } from '@main/constant'
import { configManager } from '@main/services/ConfigManager'
import { APP_NAME, APP_UPDATE_FEED_URL } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { app, autoUpdater as nativeAutoUpdater, type BrowserWindow, shell } from 'electron'
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'
import { autoUpdater } from 'electron-updater'
import semver from 'semver'

import { allowAssistantExit } from './AssistantExitGuard'

export type AppUpdateCheckSource = 'auto' | 'manual'

export interface AppUpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
}

export interface AppUpdateEventInfo extends AppUpdateInfo {
  currentVersion: string
  source: AppUpdateCheckSource
  status?: AppUpdateState['status']
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
  | {
      success: true
      status: 'manual-installer-opened'
      updateInfo: AppUpdateInfo
      installerPath: string
      fallbackToFolder?: boolean
      message?: string
    }
  | {
      success: false
      status: 'not-downloaded' | 'error' | 'cancelled'
      message: string
      updateInfo: AppUpdateInfo | null
      stage?: 'package-missing' | 'prepare-installer' | 'open-installer' | 'start-installer'
      installerPath?: string
    }

export type AppUpdateCheckResult =
  | AppUpdateCheckResultAvailable
  | AppUpdateCheckResultUpToDate
  | AppUpdateCheckResultDownloading
  | AppUpdateCheckResultDownloaded
  | AppUpdateCheckResultError

const logger = loggerService.withContext('AppUpdateService')
const STARTUP_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const WIN_INSTALL_START_TIMEOUT_MS = 60000
const MAC_MANUAL_INSTALL_QUIT_DELAY_MS = 1200
const DEFAULT_UPDATE_FEED_URL = 'https://download.925636.xyz/zen-ai/'
const MAC_MANUAL_UPDATE_DIR_NAME = 'Zen AI Updates'

type UpdateReadyResult = { success: true; updateInfo: AppUpdateInfo } | { success: false; message: string }

export class AppUpdateService {
  private readonly feedUrl = APP_UPDATE_FEED_URL.trim()
  private latestUpdateInfo: AppUpdateInfo | null = null
  private downloadedUpdateInfo: AppUpdateInfo | null = null
  private progressInfo: AppUpdateProgressInfo | null = null
  private downloadedUpdateReady = false
  private checking = false
  private downloading = false
  private startupTimeout: NodeJS.Timeout | null = null
  private periodicTimer: NodeJS.Timeout | null = null
  private currentSource: AppUpdateCheckSource = 'auto'
  private currentState: AppUpdateState
  private installPromise: Promise<AppUpdateInstallResult> | undefined

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly currentVersion: string,
    private readonly shouldAutoDownload: () => boolean
  ) {
    this.downloadedUpdateInfo = this.restorePendingUpdateInfo()
    if (isMac && this.downloadedUpdateInfo && !this.hasMacManualInstaller(this.downloadedUpdateInfo.version)) {
      this.clearPendingUpdateInfo()
    }
    this.currentState = {
      // A persisted version is not proof that electron-updater has restored
      // and verified its installer payload in this process.
      status: this.downloadedUpdateInfo ? 'checking' : 'idle',
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
      if (this.checking || this.downloading || this.installPromise) return
      if (!this.shouldAutoDownload()) {
        return
      }

      void this.checkForUpdates('auto')
    }

    this.startupTimeout = setTimeout(() => {
      if (this.downloadedUpdateInfo && !this.downloadedUpdateReady) {
        // Restore the updater's verified cache before offering installation,
        // rather than doing a network check after the user clicks Install.
        if (this.checking || this.downloading) return
        void this.ensureDownloadedUpdateReady(this.downloadedUpdateInfo).then((result) => {
          if (!result.success) this.handleUpdateError('auto', result.message)
        })
      } else runAutoCheck()
    }, delayMs)
    this.periodicTimer = setInterval(runAutoCheck, STARTUP_CHECK_INTERVAL_MS)
  }

  async checkForUpdates(source: AppUpdateCheckSource = 'manual'): Promise<AppUpdateCheckResult> {
    if (this.downloading || this.checking || this.installPromise) {
      return {
        status: 'downloading',
        currentVersion: this.currentVersion,
        source: this.currentSource,
        updateInfo: this.latestUpdateInfo ?? this.downloadedUpdateInfo
      }
    }
    this.currentSource = source
    autoUpdater.autoDownload = isMac ? false : source === 'manual' ? false : this.shouldAutoDownload()
    const pendingUpdateInfo = this.downloadedUpdateReady ? this.getReadyPendingUpdateInfo() : null
    this.setState({
      status: 'checking',
      source,
      autoUpdateEnabled: this.shouldAutoDownload(),
      currentVersion: this.currentVersion,
      updateInfo: pendingUpdateInfo ?? this.latestUpdateInfo,
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

    try {
      this.checking = true
      const result = await autoUpdater.checkForUpdates()
      const updateInfo = this.normalizeUpdateInfo(result?.updateInfo)
      const hasNewerServerUpdate = this.isNewerUpdate(updateInfo.version, pendingUpdateInfo?.version)

      if (!result?.isUpdateAvailable || (pendingUpdateInfo && !hasNewerServerUpdate)) {
        if (pendingUpdateInfo) {
          this.downloadedUpdateInfo = pendingUpdateInfo
          this.setState({
            status: 'downloaded',
            source,
            autoUpdateEnabled: this.shouldAutoDownload(),
            currentVersion: this.currentVersion,
            updateInfo: pendingUpdateInfo,
            progress: null
          })
          return {
            status: 'downloaded',
            currentVersion: this.currentVersion,
            source,
            updateInfo: pendingUpdateInfo
          }
        }

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
      if (pendingUpdateInfo && hasNewerServerUpdate && this.downloadedUpdateInfo?.version !== updateInfo.version) {
        logger.info('A newer update is available; replacing stale downloaded update info', {
          pendingVersion: pendingUpdateInfo.version,
          latestVersion: updateInfo.version
        })
        this.downloadedUpdateInfo = null
        this.downloadedUpdateReady = false
      }
      const status = this.downloadedUpdateReady ? 'downloaded' : this.downloading ? 'downloading' : 'available'
      this.setState({
        status,
        source,
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo,
        progress: this.progressInfo
      })

      if (isMac && source === 'auto' && this.shouldAutoDownload()) {
        void this.downloadUpdate('auto')
      }

      return {
        status,
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

  async downloadUpdate(source: AppUpdateCheckSource = 'manual'): Promise<AppUpdateCheckResult> {
    const pendingUpdateInfo = this.getReadyPendingUpdateInfo()

    if (!app.isPackaged) {
      return this.handleUpdateError(source, `${APP_NAME} only supports auto update after installation packaging.`)
    }

    if (isPortable) {
      return this.handleUpdateError(
        source,
        'Portable builds do not support automatic in-place updates. Please use the installer build.'
      )
    }

    if (pendingUpdateInfo) {
      const hasNewerServerUpdate =
        this.latestUpdateInfo && this.isNewerUpdate(this.latestUpdateInfo.version, pendingUpdateInfo.version)
      if (hasNewerServerUpdate) {
        logger.info('Downloading newer update instead of using stale pending package', {
          pendingVersion: pendingUpdateInfo.version,
          latestVersion: this.latestUpdateInfo?.version
        })
        this.downloadedUpdateInfo = null
        this.downloadedUpdateReady = false
      } else if (!this.downloadedUpdateReady) {
        logger.info('Pending update metadata exists but installer payload is not ready in this process')
      } else {
        this.setState({
          status: 'downloaded',
          source,
          autoUpdateEnabled: this.shouldAutoDownload(),
          currentVersion: this.currentVersion,
          updateInfo: pendingUpdateInfo,
          progress: null
        })
        return {
          status: 'downloaded',
          currentVersion: this.currentVersion,
          source,
          updateInfo: pendingUpdateInfo
        }
      }
    }

    if (this.downloading) {
      this.setState({
        status: 'downloading',
        source: this.currentSource,
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo: this.latestUpdateInfo,
        progress: this.progressInfo
      })
      return {
        status: 'downloading',
        currentVersion: this.currentVersion,
        source: this.currentSource,
        updateInfo: this.latestUpdateInfo
      }
    }

    this.currentSource = source
    autoUpdater.autoDownload = false

    if (!this.latestUpdateInfo) {
      const result = await this.checkForUpdates('manual')
      if (result.status !== 'available') {
        return result
      }
    }

    try {
      this.downloading = true
      const updateInfo = this.latestUpdateInfo
      if (!updateInfo) {
        return this.handleUpdateError(source, 'No update is available to download.')
      }

      this.setState({
        status: 'downloading',
        source,
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo,
        progress: this.progressInfo
      })

      if (isMac) {
        await this.prepareMacManualInstaller(updateInfo)
        return {
          status: 'downloaded',
          currentVersion: this.currentVersion,
          source,
          updateInfo
        }
      }

      autoUpdater.autoDownload = true
      await autoUpdater.downloadUpdate()
      if (!this.downloadedUpdateReady || this.downloadedUpdateInfo?.version !== updateInfo.version)
        this.markDownloadedUpdateReady(updateInfo)

      return {
        status: 'downloaded',
        currentVersion: this.currentVersion,
        source,
        updateInfo
      }
    } catch (error) {
      this.downloading = false
      return this.handleUpdateError(source, error instanceof Error ? error.message : String(error))
    }
  }

  quitAndInstall(): Promise<AppUpdateInstallResult> {
    // Multiple windows/repeated clicks must share the same preparation and
    // launch, including the asynchronous assistant-exit confirmation.
    if (this.installPromise) return this.installPromise
    this.installPromise = this.performInstall().then(
      (result) => {
        if (!result.success || (result.status === 'manual-installer-opened' && result.fallbackToFolder))
          this.installPromise = undefined
        return result
      },
      (error) => {
        this.installPromise = undefined
        throw error
      }
    )
    return this.installPromise
  }

  private async performInstall(): Promise<AppUpdateInstallResult> {
    const startedAt = performance.now()
    const mark = (stage: string) =>
      logger.info('App update install stage', { stage, elapsedMs: Math.round(performance.now() - startedAt) })
    mark('requested')
    const updateInfo = this.getReadyPendingUpdateInfo()

    if (!updateInfo) {
      const message = 'Update package has not been downloaded yet.'
      logger.warn('Cannot install update because no downloaded update is available')
      return {
        success: false,
        status: 'not-downloaded',
        message,
        stage: 'package-missing',
        updateInfo: null
      }
    }

    let installUpdateInfo = updateInfo

    if (!(await allowAssistantExit())) return { success: false, status: 'cancelled', message: '', updateInfo }
    mark('exit-confirmed')

    if (!this.downloadedUpdateReady) {
      mark('preparing-package')
      const readyResult = await this.ensureDownloadedUpdateReady(updateInfo)
      if (!readyResult.success) {
        return {
          success: false,
          status: 'error',
          message: readyResult.message,
          stage: 'prepare-installer',
          updateInfo
        }
      }
      installUpdateInfo = readyResult.updateInfo
    }

    this.downloadedUpdateInfo = installUpdateInfo
    this.latestUpdateInfo = installUpdateInfo
    this.progressInfo = null
    this.setState({
      status: 'downloaded',
      source: this.currentSource,
      autoUpdateEnabled: this.shouldAutoDownload(),
      currentVersion: this.currentVersion,
      updateInfo: installUpdateInfo,
      progress: null
    })

    mark('package-ready')

    try {
      app.isInstallingUpdate = true
      app.isQuitting = true
      logger.info('Quitting and installing downloaded app update', { version: installUpdateInfo.version })

      if (isMac) {
        const installerPath = await this.prepareMacManualInstaller(installUpdateInfo)
        const openResult = await this.openMacManualInstaller(installerPath)
        if (openResult.fallbackToFolder) {
          app.isInstallingUpdate = false
          app.isQuitting = false
        } else {
          this.clearPendingUpdateInfo()
          this.scheduleMacManualInstallQuit(installerPath)
        }
        return {
          success: true,
          status: 'manual-installer-opened',
          updateInfo: installUpdateInfo,
          installerPath,
          ...openResult
        }
      }

      const installStart = this.waitForInstallStart()
      const previousParentPid = process.env.ZEN_AI_UPDATE_PARENT_PID
      try {
        // The NSIS child inherits this marker. It must wait for the old app's
        // bounded asynchronous cleanup before checking/killing running apps.
        process.env.ZEN_AI_UPDATE_PARENT_PID = String(process.pid)
        mark('launching-installer')
        autoUpdater.quitAndInstall(false, true)
      } catch (error) {
        installStart.cancel()
        throw error
      } finally {
        if (previousParentPid === undefined) delete process.env.ZEN_AI_UPDATE_PARENT_PID
        else process.env.ZEN_AI_UPDATE_PARENT_PID = previousParentPid
      }
      const installStarted = await installStart.promise
      if (!installStarted) {
        app.isInstallingUpdate = false
        app.isQuitting = false
        const message = '更新安装器暂时没有启动。请再次点击“立即安装”，或退出并重新打开软件后完成更新。'
        logger.warn('Update installer did not start after quitAndInstall', { version: installUpdateInfo.version })
        return {
          success: false,
          status: 'error',
          message,
          stage: 'start-installer',
          updateInfo: installUpdateInfo
        }
      }
      mark('quit-for-update')
      // Keep the pending record until the new version actually starts. A quit
      // notification is not proof that UAC/install completed successfully.
      return {
        success: true,
        status: 'installing',
        updateInfo: installUpdateInfo
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
        stage: isMac ? 'open-installer' : 'start-installer',
        updateInfo: installUpdateInfo
      }
    }
  }

  async openDownloadedInstaller(): Promise<AppUpdateInstallResult> {
    if (!isMac) {
      return this.quitAndInstall()
    }

    const updateInfo = this.getReadyPendingUpdateInfo() ?? this.latestUpdateInfo

    if (!updateInfo) {
      const message = 'Update package has not been downloaded yet.'
      logger.warn('Cannot open macOS update installer because no update is available')
      return {
        success: false,
        status: 'not-downloaded',
        message,
        updateInfo: null
      }
    }

    try {
      const installerPath = await this.prepareMacManualInstaller(updateInfo)
      const openResult = await this.openMacManualInstaller(installerPath)
      return {
        success: true,
        status: 'manual-installer-opened',
        updateInfo,
        installerPath,
        ...openResult
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to open downloaded macOS update installer', { error: message })
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
      this.downloading = !isMac && autoUpdater.autoDownload
      this.progressInfo = null
      this.setState({
        status: !isMac && autoUpdater.autoDownload ? 'downloading' : 'available',
        source: this.currentSource,
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo,
        progress: this.progressInfo
      })

      const payload: AppUpdateEventInfo = {
        ...updateInfo,
        currentVersion: this.currentVersion,
        source: this.currentSource,
        status: this.currentState.status
      }
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
      if (isMac) {
        return
      }
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
      if (isMac) {
        logger.info('Ignoring electron-updater downloaded event on macOS; waiting for manual DMG payload')
        return
      }
      this.downloading = false
      const updateInfo = this.normalizeUpdateInfo(event)
      this.latestUpdateInfo = updateInfo
      this.downloadedUpdateInfo = updateInfo
      this.downloadedUpdateReady = true
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

      const payload: AppUpdateEventInfo = {
        ...updateInfo,
        currentVersion: this.currentVersion,
        source: this.currentSource,
        status: this.currentState.status
      }
      this.sendEvent(IpcChannel.UpdateDownloaded, payload)
      logger.info('App update downloaded', payload)
    })

    autoUpdater.on('error', (error) => {
      this.checking = false
      this.downloading = false
      this.downloadedUpdateReady = false
      this.progressInfo = null
      this.handleUpdateError(this.currentSource, error instanceof Error ? error.message : String(error))
    })
  }

  private async ensureDownloadedUpdateReady(updateInfo: AppUpdateInfo): Promise<UpdateReadyResult> {
    if (isMac) {
      try {
        await this.prepareMacManualInstaller(updateInfo)
        return { success: true, updateInfo }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `Failed to prepare the macOS installer: ${message}`
        }
      }
    }

    logger.info('Preparing update installer payload before quitAndInstall', { version: updateInfo.version })
    this.downloading = true
    this.progressInfo = null
    this.setState({
      status: 'downloading',
      source: this.currentSource,
      autoUpdateEnabled: this.shouldAutoDownload(),
      currentVersion: this.currentVersion,
      updateInfo,
      progress: null
    })

    try {
      autoUpdater.autoDownload = false
      const result = await autoUpdater.checkForUpdates()
      if (!result?.isUpdateAvailable) {
        this.downloading = false
        this.downloadedUpdateReady = false
        this.downloadedUpdateInfo = null
        this.clearPendingUpdateInfo()
        return {
          success: false,
          message: 'The downloaded update is no longer available. Please check for updates again.'
        }
      }

      const latestUpdateInfo = this.normalizeUpdateInfo(result.updateInfo)
      this.latestUpdateInfo = latestUpdateInfo
      this.downloadedUpdateInfo = latestUpdateInfo
      this.persistPendingUpdateInfo(latestUpdateInfo)

      autoUpdater.autoDownload = true
      await autoUpdater.downloadUpdate()
      if (!this.downloadedUpdateReady || this.downloadedUpdateInfo?.version !== latestUpdateInfo.version)
        this.markDownloadedUpdateReady(latestUpdateInfo)
      this.downloading = false
      this.downloadedUpdateReady = true
      this.progressInfo = null
      this.setState({
        status: 'downloaded',
        source: this.currentSource,
        autoUpdateEnabled: this.shouldAutoDownload(),
        currentVersion: this.currentVersion,
        updateInfo: latestUpdateInfo,
        progress: null
      })
      return { success: true, updateInfo: latestUpdateInfo }
    } catch (error) {
      this.downloading = false
      this.downloadedUpdateReady = false
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('Failed to prepare update installer payload', { error: message })
      return {
        success: false,
        message: `Failed to prepare the update installer: ${message}`
      }
    }
  }

  private waitForInstallStart(): { promise: Promise<boolean>; cancel: () => void } {
    let cancel = () => {}
    const promise = new Promise<boolean>((resolve) => {
      let settled = false

      const cleanup = () => {
        clearTimeout(timer)
        autoUpdater.removeListener('error', onError)
        nativeAutoUpdater.removeListener('before-quit-for-update', onBeforeQuitForUpdate)
        nativeAutoUpdater.removeListener('update-downloaded', onNativeUpdateDownloaded)
        nativeAutoUpdater.removeListener('error', onError)
      }

      const finish = (started: boolean) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(started)
      }
      cancel = () => finish(false)

      const onBeforeQuitForUpdate = () => finish(true)
      const onNativeUpdateDownloaded = () => {
        logger.info('Native updater downloaded update; waiting for app quit')
      }
      const onError = (error: unknown) => {
        logger.warn('Update installer emitted an error after quitAndInstall', {
          error: error instanceof Error ? error.message : String(error)
        })
        finish(false)
      }
      const timer = setTimeout(() => finish(false), WIN_INSTALL_START_TIMEOUT_MS)

      autoUpdater.once('error', onError)
      nativeAutoUpdater.once('before-quit-for-update', onBeforeQuitForUpdate)
      nativeAutoUpdater.once('update-downloaded', onNativeUpdateDownloaded)
      nativeAutoUpdater.once('error', onError)
    })
    return { promise, cancel }
  }

  private async prepareMacManualInstaller(updateInfo: AppUpdateInfo): Promise<string> {
    if (!updateInfo.version) {
      throw new Error('Missing update version.')
    }

    const installerCandidates = this.getMacManualInstallerCandidates(updateInfo.version)
    for (const candidate of installerCandidates) {
      if (await this.isExistingFile(candidate.path)) {
        this.markDownloadedUpdateReady(updateInfo)
        return candidate.path
      }
    }

    const primaryCandidate = installerCandidates[0]
    logger.info('Downloading macOS manual update installer', {
      version: updateInfo.version,
      url: primaryCandidate.url,
      installerPath: primaryCandidate.path
    })

    this.downloading = true
    this.progressInfo = null
    this.setState({
      status: 'downloading',
      source: this.currentSource,
      autoUpdateEnabled: this.shouldAutoDownload(),
      currentVersion: this.currentVersion,
      updateInfo,
      progress: null
    })

    try {
      await mkdir(path.dirname(primaryCandidate.path), { recursive: true })
      let lastError: unknown
      for (const candidate of installerCandidates) {
        try {
          logger.info('Trying macOS manual update installer download', {
            version: updateInfo.version,
            url: candidate.url,
            installerPath: candidate.path
          })
          await this.downloadFile(candidate.url, primaryCandidate.path)
          this.markDownloadedUpdateReady(updateInfo)
          return primaryCandidate.path
        } catch (error) {
          lastError = error
          logger.warn('macOS manual update installer download candidate failed', {
            version: updateInfo.version,
            url: candidate.url,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError))
    } finally {
      this.downloading = false
    }
  }

  private async openMacManualInstaller(installerPath: string) {
    const openError = await shell.openPath(installerPath)
    if (!openError) {
      return {
        fallbackToFolder: false,
        message: 'macOS installer opened.'
      }
    }

    logger.warn('Failed to open macOS update DMG directly; revealing installer in Finder instead', {
      installerPath,
      error: openError
    })
    shell.showItemInFolder(installerPath)
    return {
      fallbackToFolder: true,
      message: openError
    }
  }

  private scheduleMacManualInstallQuit(installerPath: string) {
    setTimeout(() => {
      logger.info('Quitting app after opening macOS manual installer', { installerPath })
      app.quit()
    }, MAC_MANUAL_INSTALL_QUIT_DELAY_MS)
  }

  private getReadyPendingUpdateInfo() {
    const pendingUpdateInfo = this.downloadedUpdateInfo ?? this.restorePendingUpdateInfo()
    if (!pendingUpdateInfo) {
      return null
    }

    if (isMac && this.downloadedUpdateReady) {
      return pendingUpdateInfo
    }

    if (isMac && !this.hasMacManualInstaller(pendingUpdateInfo.version)) {
      this.clearPendingUpdateInfo()
      return null
    }

    return pendingUpdateInfo
  }

  private hasMacManualInstaller(version: string) {
    return this.getMacManualInstallerCandidates(version).some((candidate) => {
      try {
        const file = statSync(candidate.path)
        return file.isFile() && file.size > 0
      } catch {
        return false
      }
    })
  }

  private getMacManualInstallerCandidates(version: string) {
    return this.getMacManualInstallerFilenames(version).map((filename) => ({
      filename,
      url: this.getMacManualInstallerUrl(filename),
      path: this.getMacManualInstallerPath(filename)
    }))
  }

  private getMacManualInstallerFilenames(version: string) {
    const arch = process.arch
    return [
      `Zen-AI-${version}-macos-${arch}.dmg`,
      `Zen AI-${version}-macos-${arch}.dmg`,
      `Zen.AI-${version}-macos-${arch}.dmg`
    ]
  }

  private getMacManualInstallerUrl(filename: string) {
    const baseUrl = this.feedUrl || DEFAULT_UPDATE_FEED_URL
    const encodedFilename = filename
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    return new URL(encodedFilename, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
  }

  private getMacManualInstallerPath(filename: string) {
    return path.join(app.getPath('downloads'), MAC_MANUAL_UPDATE_DIR_NAME, filename)
  }

  private markDownloadedUpdateReady(updateInfo: AppUpdateInfo) {
    this.downloading = false
    this.downloadedUpdateInfo = updateInfo
    this.latestUpdateInfo = updateInfo
    this.downloadedUpdateReady = true
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

    const payload: AppUpdateEventInfo = {
      ...updateInfo,
      currentVersion: this.currentVersion,
      source: this.currentSource,
      status: this.currentState.status
    }
    this.sendEvent(IpcChannel.UpdateDownloaded, payload)
  }

  private async isExistingFile(filePath: string) {
    try {
      const fileStat = await stat(filePath)
      return fileStat.isFile() && fileStat.size > 0
    } catch {
      return false
    }
  }

  private async downloadFile(url: string, destinationPath: string, redirects = 0): Promise<void> {
    if (redirects > 5) throw new Error('Too many installer download redirects.')
    const temporaryPath = `${destinationPath}.download`
    await unlink(temporaryPath).catch(() => undefined)

    await new Promise<void>((resolve, reject) => {
      const file = createWriteStream(temporaryPath)
      let settled = false

      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        file.close(() => {
          if (error) {
            void unlink(temporaryPath).catch(() => undefined)
            reject(error)
          } else {
            resolve()
          }
        })
      }

      file.on('error', finish)
      const startedAt = performance.now()
      let lastProgressAt = 0
      const downloadRequest = request(url, (response) => {
        const statusCode = response.statusCode ?? 0
        if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
          file.close(() => {
            void unlink(temporaryPath).catch(() => undefined)
            response.resume()
            this.downloadFile(new URL(response.headers.location!, url).toString(), destinationPath, redirects + 1).then(
              resolve,
              reject
            )
          })
          return
        }

        if (statusCode !== 200) {
          response.resume()
          finish(new Error(`Download failed with HTTP ${statusCode}.`))
          return
        }

        const total = Number(response.headers['content-length'] ?? 0)
        let transferred = 0
        response.on('data', (chunk: Buffer) => {
          transferred += chunk.length
          const now = performance.now()
          if (now - lastProgressAt < 250 && (total <= 0 || transferred < total)) return
          lastProgressAt = now
          this.progressInfo = {
            percent: total > 0 ? Math.max(0, Math.min(100, (transferred / total) * 100)) : 0,
            transferred,
            total,
            bytesPerSecond: Math.round(transferred / Math.max(0.001, (now - startedAt) / 1000))
          }
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
        response.on('error', finish)
        response.on('aborted', () => finish(new Error('Installer download was interrupted. Please retry.')))
        file.on('finish', () => finish())
        response.pipe(file)
      })
      downloadRequest.setTimeout(30_000, () => {
        downloadRequest.destroy(new Error('Installer download stopped responding. Please retry.'))
      })
      downloadRequest.on('error', finish).end()
    })

    await rename(temporaryPath, destinationPath)
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
    this.downloadedUpdateInfo = null
    this.downloadedUpdateReady = false
    configManager.setPendingUpdateInfo(null)
  }

  private isNewerUpdate(candidateVersion: string | undefined, baselineVersion: string | undefined) {
    if (!candidateVersion || !baselineVersion) {
      return false
    }

    const candidate = semver.coerce(candidateVersion)
    const baseline = semver.coerce(baselineVersion)

    if (!candidate || !baseline) {
      return candidateVersion !== baselineVersion
    }

    return semver.gt(candidate, baseline)
  }

  private sendEvent(channel: IpcChannel, payload: unknown) {
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload)
    }
  }
}
