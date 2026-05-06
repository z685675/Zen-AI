import { loggerService } from '@logger'
import { APP_NAME, APP_UPDATE_METADATA_URL } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { net, type BrowserWindow } from 'electron'
import semver from 'semver'

export type AppUpdateCheckSource = 'auto' | 'manual'

export interface AppUpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
  downloadPage: string
  mandatory?: boolean
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
  | AppUpdateCheckResultError

const logger = loggerService.withContext('AppUpdateService')

export class AppUpdateService {
  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly currentVersion: string
  ) {}

  scheduleStartupCheck(delayMs = 5000) {
    setTimeout(() => {
      void this.checkForUpdates('auto')
    }, delayMs)
  }

  async checkForUpdates(source: AppUpdateCheckSource = 'manual'): Promise<AppUpdateCheckResult> {
    try {
      if (!APP_UPDATE_METADATA_URL.trim()) {
        throw new Error(`${APP_NAME} update metadata URL is not configured.`)
      }

      const currentSemver = semver.valid(this.currentVersion) ?? semver.coerce(this.currentVersion)?.version

      if (!currentSemver) {
        throw new Error(`Invalid current app version: ${this.currentVersion}`)
      }

      const updateInfo = await this.fetchUpdateInfo()

      if (semver.gt(updateInfo.version, currentSemver)) {
        const payload = { ...updateInfo, currentVersion: this.currentVersion, source }
        this.sendEvent(IpcChannel.UpdateAvailable, payload)
        logger.info('App update available', payload)

        return {
          status: 'available',
          currentVersion: this.currentVersion,
          source,
          updateInfo
        }
      }

      const payload = {
        currentVersion: this.currentVersion,
        source,
        latestVersion: updateInfo.version
      }
      this.sendEvent(IpcChannel.UpdateNotAvailable, payload)
      logger.info('App already up to date', payload)

      return {
        status: 'up-to-date',
        currentVersion: this.currentVersion,
        source,
        updateInfo: null,
        latestVersion: updateInfo.version
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
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
  }

  private async fetchUpdateInfo(): Promise<AppUpdateInfo> {
    if (!this.isHttpUrl(APP_UPDATE_METADATA_URL)) {
      throw new Error(`Invalid update metadata URL: ${APP_UPDATE_METADATA_URL}`)
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 8000)

    try {
      const response = await net.fetch(APP_UPDATE_METADATA_URL, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch update metadata: HTTP ${response.status}`)
      }

      const data = (await response.json()) as Partial<AppUpdateInfo>
      const version = typeof data.version === 'string' ? data.version.trim() : ''
      const downloadPage = typeof data.downloadPage === 'string' ? data.downloadPage.trim() : ''

      if (!semver.valid(version)) {
        throw new Error('Invalid update version in latest.json')
      }

      if (!this.isHttpUrl(downloadPage)) {
        throw new Error('Invalid downloadPage in latest.json')
      }

      return {
        version,
        releaseDate: typeof data.releaseDate === 'string' ? data.releaseDate.trim() : undefined,
        releaseNotes: typeof data.releaseNotes === 'string' ? data.releaseNotes.trim() : undefined,
        downloadPage,
        mandatory: Boolean(data.mandatory)
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Update check timed out')
      }

      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private sendEvent(channel: IpcChannel, payload: unknown) {
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload)
    }
  }

  private isHttpUrl(value: string) {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }
}
