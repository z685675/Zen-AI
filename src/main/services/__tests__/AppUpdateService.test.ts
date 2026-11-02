import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type * as NodeFs from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
const httpRequest = vi.hoisted(() => vi.fn())
vi.mock('node:https', () => ({ request: httpRequest }))

const mockAutoUpdaterEmitter = new EventEmitter()
const mockAutoUpdater = Object.assign(mockAutoUpdaterEmitter, {
  autoDownload: true,
  autoInstallOnAppQuit: false,
  allowPrerelease: false,
  allowDowngrade: false,
  logger: undefined as unknown,
  setFeedURL: vi.fn(),
  quitAndInstall: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn()
})
vi.spyOn(mockAutoUpdaterEmitter, 'on')

const mockNativeAutoUpdater = new EventEmitter()
const mockShell = {
  openPath: vi.fn(),
  showItemInFolder: vi.fn()
}

const configManagerMock = {
  getPendingUpdateInfo: vi.fn(),
  setPendingUpdateInfo: vi.fn()
}

let mockIsMac = false

const mockApp = Object.assign(new EventEmitter(), {
  isPackaged: true,
  isQuitting: false,
  isInstallingUpdate: false,
  quit: vi.fn(),
  getPath: vi.fn(() => path.join('mock', 'Downloads'))
})

const mockDownloadsPath = path.resolve('mock', 'Downloads')
const mockMacInstallerPath = path.join(mockDownloadsPath, 'Zen AI Updates', `Zen-AI-1.1.0-macos-${process.arch}.dmg`)
const macIntegrity = { sha512: Buffer.alloc(64, 7).toString('base64'), size: 1024 }
const macMetadata = {
  version: '1.1.0',
  files: [{ url: `Zen-AI-1.1.0-macos-${process.arch}.dmg`, ...macIntegrity }]
}

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    })
  }
}))

vi.mock('@main/constant', () => ({
  get isMac() {
    return mockIsMac
  },
  isPortable: false
}))

vi.mock('@main/services/ConfigManager', () => ({
  configManager: configManagerMock
}))

vi.mock('@main/utils/locales', () => ({ t: (key: string) => key }))

vi.mock('@shared/config/constant', () => ({
  APP_NAME: 'Zen AI',
  APP_UPDATE_FEED_URL: 'https://example.com/releases'
}))

vi.mock('@shared/IpcChannel', () => ({
  IpcChannel: {
    UpdateAvailable: 'update-available',
    UpdateNotAvailable: 'update-not-available',
    DownloadProgress: 'download-progress',
    UpdateDownloaded: 'update-downloaded',
    UpdateError: 'update-error'
  }
}))

vi.mock('electron', () => ({
  app: mockApp,
  autoUpdater: mockNativeAutoUpdater,
  shell: mockShell
}))

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater
}))
const allowExit = vi.hoisted(() => vi.fn(() => true))
vi.mock('../AssistantExitGuard', () => ({ allowAssistantExit: allowExit }))

describe('AppUpdateService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    allowExit.mockReturnValue(true)
    mockIsMac = false
    mockApp.isQuitting = false
    mockApp.isInstallingUpdate = false
    configManagerMock.getPendingUpdateInfo.mockReturnValue(null)
    configManagerMock.setPendingUpdateInfo.mockReset()
    mockAutoUpdater.removeAllListeners()
    mockNativeAutoUpdater.removeAllListeners()
    mockAutoUpdater.autoDownload = true
    mockAutoUpdater.autoInstallOnAppQuit = false
    mockAutoUpdater.checkForUpdates.mockReset()
    mockAutoUpdater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: macMetadata })
    mockAutoUpdater.downloadUpdate.mockReset()
    mockAutoUpdater.quitAndInstall.mockReset()
    httpRequest.mockReset()
    mockShell.openPath.mockReset()
    mockShell.openPath.mockResolvedValue('')
    mockShell.showItemInFolder.mockReset()
    mockApp.quit.mockReset()
    mockApp.getPath.mockReturnValue(mockDownloadsPath)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a not-downloaded result when no downloaded update is available', async () => {
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    await expect(service.quitAndInstall()).resolves.toEqual({
      success: false,
      status: 'not-downloaded',
      message: 'Update package has not been downloaded yet.',
      stage: 'package-missing',
      updateInfo: null
    })
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(mockApp.isInstallingUpdate).toBe(false)
  })

  it('retains the downloaded update and running tasks when exit is cancelled', async () => {
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => true
    )
    ;(service as any).downloadedUpdateInfo = { version: '1.1.0' }
    ;(service as any).downloadedUpdateReady = true
    allowExit.mockReturnValue(false)
    await expect(service.quitAndInstall()).resolves.toMatchObject({
      success: false,
      status: 'cancelled',
      updateInfo: { version: '1.1.0' }
    })
    expect(mockApp.isQuitting).toBe(false)
    expect(mockApp.isInstallingUpdate).toBe(false)
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('marks the app as installing an update before quitting', async () => {
    vi.useFakeTimers()
    mockAutoUpdater.quitAndInstall.mockImplementation(() => {
      setTimeout(() => mockNativeAutoUpdater.emit('before-quit-for-update'), 1)
    })

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    ;(service as any).downloadedUpdateInfo = { version: '1.1.0' }
    ;(service as any).downloadedUpdateReady = true

    const installResult = service.quitAndInstall()
    await vi.advanceTimersByTimeAsync(1)

    await expect(installResult).resolves.toEqual({
      success: true,
      status: 'installing',
      updateInfo: { version: '1.1.0' }
    })
    expect(configManagerMock.setPendingUpdateInfo).not.toHaveBeenCalledWith(null)
    expect(mockApp.isInstallingUpdate).toBe(true)
    expect(mockApp.isQuitting).toBe(true)
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('installs when downloaded update state is restored from pending config', async () => {
    vi.useFakeTimers()
    configManagerMock.getPendingUpdateInfo.mockReturnValue({
      version: '1.1.0',
      releaseNotes: 'pending'
    })
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: {
        version: '1.1.0',
        releaseNotes: 'fresh'
      }
    })
    mockAutoUpdater.downloadUpdate.mockResolvedValue([])
    mockAutoUpdater.quitAndInstall.mockImplementation(() => {
      setTimeout(() => mockNativeAutoUpdater.emit('before-quit-for-update'), 1)
    })

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    const installResult = service.quitAndInstall()
    await vi.advanceTimersByTimeAsync(1)

    await expect(installResult).resolves.toEqual({
      success: true,
      status: 'installing',
      updateInfo: {
        version: '1.1.0',
        releaseNotes: 'fresh'
      }
    })
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledOnce()
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('surfaces a newer server update instead of sticking to a stale downloaded update', async () => {
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: {
        version: '1.1.24',
        releaseNotes: 'newer'
      }
    })

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.1.18',
      () => true
    )

    ;(service as any).downloadedUpdateInfo = { version: '1.1.20', releaseNotes: 'stale' }
    ;(service as any).downloadedUpdateReady = true

    await expect(service.checkForUpdates('manual')).resolves.toEqual({
      status: 'available',
      currentVersion: '1.1.18',
      source: 'manual',
      updateInfo: {
        version: '1.1.24',
        releaseNotes: 'newer'
      }
    })
    expect((service as any).downloadedUpdateInfo).toBeNull()
    expect((service as any).downloadedUpdateReady).toBe(false)
  })

  it('keeps a newer cached download that finishes during metadata checking', async () => {
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.1.18',
      () => true
    )
    ;(service as any).downloadedUpdateInfo = { version: '1.1.20' }
    ;(service as any).downloadedUpdateReady = true
    mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      mockAutoUpdater.emit('update-downloaded', { version: '1.1.24' })
      return { isUpdateAvailable: true, updateInfo: { version: '1.1.24' } }
    })

    await expect(service.checkForUpdates('auto')).resolves.toMatchObject({
      status: 'downloaded',
      updateInfo: { version: '1.1.24' }
    })
    expect((service as any).downloadedUpdateReady).toBe(true)
    expect((service as any).downloadedUpdateInfo.version).toBe('1.1.24')
  })

  it('keeps an existing downloaded update when the server does not offer a newer version', async () => {
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: {
        version: '1.1.20',
        releaseNotes: 'same'
      }
    })

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.1.18',
      () => true
    )

    ;(service as any).downloadedUpdateInfo = { version: '1.1.20', releaseNotes: 'pending' }
    ;(service as any).downloadedUpdateReady = true

    await expect(service.checkForUpdates('manual')).resolves.toEqual({
      status: 'downloaded',
      currentVersion: '1.1.18',
      source: 'manual',
      updateInfo: {
        version: '1.1.20',
        releaseNotes: 'pending'
      }
    })
    expect((service as any).downloadedUpdateInfo).toEqual({ version: '1.1.20', releaseNotes: 'pending' })
  })

  it('downloads the newer update when a stale downloaded update was replaced by checkForUpdates', async () => {
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: {
        version: '1.1.24',
        releaseNotes: 'newer'
      }
    })
    mockAutoUpdater.downloadUpdate.mockResolvedValue([])

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.1.18',
      () => true
    )

    ;(service as any).downloadedUpdateInfo = { version: '1.1.20', releaseNotes: 'stale' }
    ;(service as any).downloadedUpdateReady = true

    await service.checkForUpdates('manual')
    await expect(service.downloadUpdate()).resolves.toEqual({
      status: 'downloaded',
      currentVersion: '1.1.18',
      source: 'manual',
      updateInfo: {
        version: '1.1.24',
        releaseNotes: 'newer'
      }
    })
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('keeps downloaded update pending when Windows installer does not start', async () => {
    vi.useFakeTimers()

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    ;(service as any).downloadedUpdateInfo = { version: '1.1.0' }
    ;(service as any).downloadedUpdateReady = true
    const installResult = service.quitAndInstall()
    await vi.advanceTimersByTimeAsync(60000)

    await expect(installResult).resolves.toEqual({
      success: false,
      status: 'error',
      message: expect.stringContaining('更新安装器暂时没有启动'),
      stage: 'start-installer',
      updateInfo: { version: '1.1.0' }
    })
    expect(configManagerMock.setPendingUpdateInfo).not.toHaveBeenCalledWith(null)
    expect(mockApp.isInstallingUpdate).toBe(false)
    expect(mockApp.isQuitting).toBe(false)
  })

  it('returns an error result and resets install flags when quitAndInstall throws', async () => {
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    ;(service as any).downloadedUpdateInfo = { version: '1.1.0' }
    ;(service as any).downloadedUpdateReady = true
    mockAutoUpdater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('installer failed')
    })

    await expect(service.quitAndInstall()).resolves.toEqual({
      success: false,
      status: 'error',
      message: 'installer failed',
      stage: 'start-installer',
      updateInfo: { version: '1.1.0' }
    })
    expect(mockApp.isInstallingUpdate).toBe(false)
    expect(mockApp.isQuitting).toBe(false)
  })

  it('opens the local macOS DMG installer instead of using Squirrel auto install', async () => {
    vi.useFakeTimers()
    mockIsMac = true

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    ;(service as any).downloadedUpdateInfo = { version: '1.1.0' }
    ;(service as any).downloadedUpdateReady = true
    vi.spyOn(service as any, 'isExistingFile').mockResolvedValue(true)

    const installerPath = mockMacInstallerPath

    await expect(service.quitAndInstall()).resolves.toEqual({
      success: true,
      status: 'manual-installer-opened',
      updateInfo: { version: '1.1.0' },
      installerPath,
      fallbackToFolder: false,
      message: 'macOS installer opened.'
    })
    expect(mockShell.openPath).toHaveBeenCalledWith(installerPath)
    expect(mockShell.showItemInFolder).not.toHaveBeenCalled()
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(configManagerMock.setPendingUpdateInfo).not.toHaveBeenCalledWith(null)
    expect(mockApp.isInstallingUpdate).toBe(true)
    expect(mockApp.isQuitting).toBe(true)
    expect(mockApp.quit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1200)
    expect(mockApp.quit).toHaveBeenCalledOnce()
  })

  it('can open a restored macOS pending update from the local manual installer folder', async () => {
    mockIsMac = true
    configManagerMock.getPendingUpdateInfo.mockReturnValue({
      version: '1.1.0',
      releaseNotes: 'pending'
    })

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    vi.spyOn(service as any, 'isExistingFile').mockResolvedValue(true)

    await expect(service.openDownloadedInstaller()).resolves.toMatchObject({
      success: true,
      status: 'manual-installer-opened',
      updateInfo: { version: '1.1.0', releaseNotes: 'pending' }
    })
    expect(mockShell.openPath).toHaveBeenCalledOnce()
    expect(mockShell.showItemInFolder).not.toHaveBeenCalled()
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('keeps a mounted DMG pending across old-version restarts until the newer app starts', async () => {
    mockIsMac = true
    vi.useFakeTimers()
    let pending: unknown = { version: '1.1.0', releaseNotes: 'Keep these notes', macInstaller: macIntegrity }
    configManagerMock.getPendingUpdateInfo.mockImplementation(() => pending)
    configManagerMock.setPendingUpdateInfo.mockImplementation((info) => {
      pending = info
    })
    const { AppUpdateService } = await import('../AppUpdateService')
    const makeService = (version: string) =>
      new AppUpdateService({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any, version, () => false)
    const original = makeService('1.0.0')
    vi.spyOn(original as any, 'isExistingFile').mockResolvedValue(true)
    await expect(original.quitAndInstall()).resolves.toMatchObject({ success: true, status: 'manual-installer-opened' })
    expect(pending).toMatchObject({ version: '1.1.0', releaseNotes: 'Keep these notes', macInstaller: macIntegrity })
    await vi.advanceTimersByTimeAsync(1200)
    expect(mockApp.quit).toHaveBeenCalledOnce()

    // Mounting the image does not prove the user has replaced the old app.
    const restartedOld = makeService('1.0.0')
    expect(restartedOld.getState()).toMatchObject({ status: 'checking', updateInfo: { version: '1.1.0' } })
    vi.spyOn(restartedOld as any, 'isExistingFile').mockResolvedValue(true)
    await expect(restartedOld.openDownloadedInstaller()).resolves.toMatchObject({ success: true })
    expect(restartedOld.getState().status).toBe('downloaded')
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()

    const installedNew = makeService('1.1.0')
    expect(pending).toBeNull()
    expect(installedNew.getState()).toMatchObject({ status: 'idle', updateInfo: null })
  })

  it('keeps a restored macOS pending update unverified until the local DMG is checked asynchronously', async () => {
    mockIsMac = true
    configManagerMock.getPendingUpdateInfo.mockReturnValue({
      version: '1.1.0',
      releaseNotes: 'pending'
    })

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    expect(service.getState().status).toBe('checking')
    expect(service.getState().updateInfo).toMatchObject({ version: '1.1.0' })
    expect(configManagerMock.setPendingUpdateInfo).not.toHaveBeenCalled()
  })

  it('reveals the local macOS installer in Finder when opening the DMG directly fails', async () => {
    mockIsMac = true
    mockShell.openPath.mockResolvedValueOnce('permission denied')

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    ;(service as any).downloadedUpdateInfo = { version: '1.1.0' }
    ;(service as any).downloadedUpdateReady = true
    vi.spyOn(service as any, 'isExistingFile').mockResolvedValue(true)

    const installerPath = mockMacInstallerPath

    await expect(service.openDownloadedInstaller()).resolves.toEqual({
      success: true,
      status: 'manual-installer-opened',
      updateInfo: { version: '1.1.0' },
      installerPath,
      fallbackToFolder: true,
      message: 'permission denied'
    })
    expect(mockShell.openPath).toHaveBeenCalledWith(installerPath)
    expect(mockShell.showItemInFolder).toHaveBeenCalledWith(installerPath)
  })

  it('does not quit automatically when macOS installer falls back to Finder reveal during install', async () => {
    vi.useFakeTimers()
    mockIsMac = true
    mockShell.openPath.mockResolvedValueOnce('permission denied')

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    ;(service as any).downloadedUpdateInfo = { version: '1.1.0' }
    ;(service as any).downloadedUpdateReady = true
    vi.spyOn(service as any, 'isExistingFile').mockResolvedValue(true)

    await expect(service.quitAndInstall()).resolves.toMatchObject({
      success: true,
      status: 'manual-installer-opened',
      fallbackToFolder: true,
      message: 'permission denied'
    })

    await vi.advanceTimersByTimeAsync(1200)
    expect(mockApp.quit).not.toHaveBeenCalled()
    expect(mockApp.isInstallingUpdate).toBe(false)
    expect(mockApp.isQuitting).toBe(false)
  })

  it('does not treat electron-updater macOS zip download as a ready DMG installer', async () => {
    mockIsMac = true

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    mockAutoUpdater.emit('update-downloaded', { version: '1.1.0' })

    expect(service.getState().status).toBe('idle')
    expect(service.getState().updateInfo).toBeNull()
    expect(configManagerMock.setPendingUpdateInfo).not.toHaveBeenCalled()
  })

  it('falls back across macOS manual installer asset name variants', async () => {
    mockIsMac = true

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    ;(service as any).downloadedUpdateInfo = { version: '1.1.0' }
    ;(service as any).downloadedUpdateReady = true
    vi.spyOn(service as any, 'isExistingFile')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const downloadFile = vi
      .spyOn(service as any, 'downloadFile')
      .mockRejectedValueOnce(new Error('Download failed with HTTP 404.'))
      .mockRejectedValueOnce(new Error('Download failed with HTTP 404.'))
      .mockResolvedValueOnce(undefined)

    await expect(service.openDownloadedInstaller()).resolves.toMatchObject({
      success: true,
      status: 'manual-installer-opened',
      updateInfo: { version: '1.1.0' }
    })

    expect(downloadFile).toHaveBeenNthCalledWith(
      1,
      `https://example.com/releases/Zen-AI-1.1.0-macos-${process.arch}.dmg`,
      mockMacInstallerPath
    )
    expect(downloadFile).toHaveBeenNthCalledWith(
      2,
      `https://example.com/releases/Zen%20AI-1.1.0-macos-${process.arch}.dmg`,
      mockMacInstallerPath
    )
    expect(downloadFile).toHaveBeenNthCalledWith(
      3,
      `https://example.com/releases/Zen.AI-1.1.0-macos-${process.arch}.dmg`,
      mockMacInstallerPath
    )
    expect(mockShell.openPath).toHaveBeenCalledWith(mockMacInstallerPath)
  })

  it('does not re-download an already downloaded macOS update when no newer version exists', async () => {
    mockIsMac = true
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: macMetadata
    })

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    ;(service as any).downloadedUpdateInfo = { version: '1.1.0', macInstaller: macIntegrity }
    ;(service as any).downloadedUpdateReady = true
    vi.spyOn(service as any, 'isExistingFile').mockResolvedValue(true)

    const checkResult = await service.checkForUpdates('manual')
    expect(checkResult.status).toBe('downloaded')

    await expect(service.quitAndInstall()).resolves.toMatchObject({
      success: true,
      status: 'manual-installer-opened',
      updateInfo: { version: '1.1.0' }
    })
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('retries preparation of a missing restored DMG without quitting on download failure', async () => {
    mockIsMac = true
    configManagerMock.getPendingUpdateInfo.mockReturnValue({
      version: '1.1.0',
      releaseNotes: 'pending'
    })

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    vi.spyOn(service as any, 'downloadFile').mockRejectedValue(new Error('offline'))
    await expect(service.quitAndInstall()).resolves.toMatchObject({
      success: false,
      status: 'error',
      stage: 'prepare-installer'
    })
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(mockShell.openPath).not.toHaveBeenCalled()
    expect(mockApp.quit).not.toHaveBeenCalled()
  })

  it('restores downloaded update state from pending config on startup for non-macOS updates', async () => {
    configManagerMock.getPendingUpdateInfo.mockReturnValue({
      version: '1.1.0',
      releaseNotes: 'pending'
    })

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    expect(service.getState().status).toBe('checking')
    expect(service.getState().updateInfo?.version).toBe('1.1.0')
  })

  it('keeps periodic auto checks available after auto update is enabled later in the session', async () => {
    vi.useFakeTimers()

    let autoUpdateEnabled = false
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '1.0.1' }
    })

    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => autoUpdateEnabled
    )

    service.scheduleStartupCheck(1000)

    await vi.advanceTimersByTimeAsync(1000)
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()

    autoUpdateEnabled = true

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('keeps macOS background manual-installer downloads associated with the auto check source', async () => {
    mockIsMac = true
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.1.0' }
    })

    const { AppUpdateService } = await import('../AppUpdateService')
    const webContents = { send: vi.fn() }
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents
      } as any,
      '1.0.0',
      () => true
    )

    vi.spyOn(service as any, 'prepareMacManualInstaller').mockImplementation(async (updateInfo) => {
      ;(service as any).markDownloadedUpdateReady(updateInfo)
      return mockMacInstallerPath
    })

    await service.checkForUpdates('auto')
    await vi.waitFor(() => {
      expect(service.getState().status).toBe('downloaded')
    })

    const downloadedPayload = webContents.send.mock.calls.find(([channel]) => channel === 'update-downloaded')?.[1]
    expect(downloadedPayload).toMatchObject({
      version: '1.1.0',
      source: 'auto',
      status: 'downloaded'
    })
  })

  it('keeps macOS zip target configured for auto update compatibility', async () => {
    const fs = await vi.importActual<typeof NodeFs>('node:fs')
    const configPath = path.join(process.cwd(), 'electron-builder.yml')
    const config = fs.readFileSync(configPath, 'utf8')

    expect(config).toMatch(/^mac:\n[\s\S]*?target:\n[\s\S]*?-\s*target:\s*dmg/m)
    expect(config).toMatch(/^mac:\n[\s\S]*?target:\n[\s\S]*?-\s*target:\s*zip/m)
  })
  it('coalesces repeated install requests, passes the parent PID only to the launcher, and keeps the recovery record', async () => {
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => true
    )
    ;(service as any).downloadedUpdateInfo = { version: '1.1.0' }
    ;(service as any).downloadedUpdateReady = true
    const original = process.env.ZEN_AI_UPDATE_PARENT_PID
    mockAutoUpdater.quitAndInstall.mockImplementation(() => {
      expect(process.env.ZEN_AI_UPDATE_PARENT_PID).toBe(String(process.pid))
      mockNativeAutoUpdater.emit('before-quit-for-update')
    })
    const first = service.quitAndInstall()
    expect(service.quitAndInstall()).toBe(first)
    await expect(first).resolves.toMatchObject({ success: true, status: 'installing' })
    expect(service.quitAndInstall()).toBe(first)
    expect(process.env.ZEN_AI_UPDATE_PARENT_PID).toBe(original)
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledOnce()
    expect(configManagerMock.setPendingUpdateInfo).not.toHaveBeenCalledWith(null)
    expect(mockNativeAutoUpdater.listenerCount('before-quit-for-update')).toBe(0)
  })

  it('does not treat an unrelated application quit as installer launch confirmation', async () => {
    vi.useFakeTimers()
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => true
    )
    ;(service as any).downloadedUpdateInfo = { version: '1.1.0' }
    ;(service as any).downloadedUpdateReady = true
    mockAutoUpdater.quitAndInstall.mockImplementation(() => mockApp.emit('before-quit'))
    const result = service.quitAndInstall()
    await vi.advanceTimersByTimeAsync(60000)
    await expect(result).resolves.toMatchObject({ success: false, stage: 'start-installer' })
    expect(configManagerMock.setPendingUpdateInfo).not.toHaveBeenCalledWith(null)
  })

  it('removes installer listeners after synchronous launch errors and permits a retry', async () => {
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => true
    )
    ;(service as any).downloadedUpdateInfo = { version: '1.1.0' }
    ;(service as any).downloadedUpdateReady = true
    mockAutoUpdater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('blocked')
    })
    await expect(service.quitAndInstall()).resolves.toMatchObject({ success: false })
    expect(mockNativeAutoUpdater.listenerCount('before-quit-for-update')).toBe(0)
    mockAutoUpdater.quitAndInstall.mockImplementationOnce(() => mockNativeAutoUpdater.emit('before-quit-for-update'))
    await expect(service.quitAndInstall()).resolves.toMatchObject({ success: true })
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(2)
  })

  it('waits for asynchronous launch confirmation without timing out a pending UAC decision', async () => {
    vi.useFakeTimers()
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => true
    )
    ;(service as any).downloadedUpdateInfo = { version: '1.1.0' }
    ;(service as any).downloadedUpdateReady = true
    let rejectLaunch!: (error: Error) => void
    mockAutoUpdater.quitAndInstall.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectLaunch = reject
        })
    )
    let settled = false
    const first = service.quitAndInstall().then((value) => {
      settled = true
      return value
    })
    await vi.advanceTimersByTimeAsync(120000)
    expect(settled).toBe(false)
    rejectLaunch(new Error('UAC declined'))
    await expect(first).resolves.toMatchObject({ success: false })
    expect(mockNativeAutoUpdater.listenerCount('before-quit-for-update')).toBe(0)
    expect(mockApp.isQuitting).toBe(false)
    mockAutoUpdater.quitAndInstall.mockImplementationOnce(async () => {
      mockNativeAutoUpdater.emit('before-quit-for-update')
    })
    await expect(service.quitAndInstall()).resolves.toMatchObject({ success: true })
  })

  it('rejects a corrupt cached DMG and an HTML download without opening it or quitting', async () => {
    mockIsMac = true
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-dmg-download-'))
    try {
      const installer = path.join(directory, 'installer.dmg')
      await writeFile(installer, '<html>cached error</html>')
      const { AppUpdateService } = await import('../AppUpdateService')
      const service = new AppUpdateService(
        { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
        '1.0.0',
        () => true
      )
      ;(service as any).downloadedUpdateInfo = { version: '1.1.0', macInstaller: macIntegrity }
      ;(service as any).downloadedUpdateReady = true
      vi.spyOn(service as any, 'getMacManualInstallerCandidates').mockReturnValue([
        { path: installer, url: 'https://example.invalid/installer.dmg' }
      ])
      vi.spyOn(service as any, 'downloadFile').mockImplementation(async () => {
        await writeFile(installer, '<html>download error</html>')
      })
      await expect(service.quitAndInstall()).resolves.toMatchObject({ success: false })
      expect(service.getState().status).not.toBe('downloaded')
      expect(mockShell.openPath).not.toHaveBeenCalled()
      expect(mockApp.quit).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['valid', 'invalid'])('handles a %s DMG redirect before offering installation', async (kind) => {
    mockIsMac = true
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-dmg-redirect-'))
    try {
      const payload = Buffer.alloc(2048, 3)
      payload.write('koly', payload.length - 512)
      const integrity = { sha512: createHash('sha512').update(payload).digest('base64'), size: payload.length }
      mockApp.getPath.mockReturnValue(directory)
      configManagerMock.getPendingUpdateInfo.mockReturnValue({ version: '1.1.0' })
      mockAutoUpdater.checkForUpdates.mockResolvedValue({
        isUpdateAvailable: true,
        updateInfo: {
          ...macMetadata,
          files: [{ ...macMetadata.files[0], ...integrity }]
        }
      })
      httpRequest.mockImplementation((url: string, callback: (response: any) => void) => {
        const redirect = !url.endsWith('/payload')
        const response = Object.assign(Readable.from(redirect ? [] : [payload]), {
          statusCode: redirect ? 302 : 200,
          headers: redirect
            ? { location: kind === 'valid' ? '/payload' : 'http://[' }
            : { 'content-length': String(payload.length) }
        })
        const request = Object.assign(new EventEmitter(), {
          setTimeout: vi.fn(),
          destroy: vi.fn(),
          end: () => queueMicrotask(() => callback(response))
        })
        return request
      })
      const { AppUpdateService } = await import('../AppUpdateService')
      const send = vi.fn()
      const service = new AppUpdateService(
        { isDestroyed: () => false, webContents: { send } } as any,
        '1.0.0',
        () => false
      )
      if (kind === 'invalid') {
        await expect(service.openDownloadedInstaller()).resolves.toMatchObject({ success: false })
        expect(service.getState().status).toBe('error')
        expect(mockShell.openPath).not.toHaveBeenCalled()
        expect(mockApp.quit).not.toHaveBeenCalled()
        return
      }
      await expect(service.openDownloadedInstaller()).resolves.toMatchObject({ success: true })
      expect(service.getState()).toMatchObject({ status: 'downloaded', updateInfo: { macInstaller: integrity } })
      expect(configManagerMock.setPendingUpdateInfo).toHaveBeenCalledWith(
        expect.objectContaining({ macInstaller: integrity })
      )
      expect(await readFile(mockShell.openPath.mock.calls[0][0])).toEqual(payload)
      expect(httpRequest).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenCalledWith('download-progress', expect.objectContaining({ percent: 100 }))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not silently substitute a newer DMG when old verification metadata is missing', async () => {
    mockIsMac = true
    configManagerMock.getPendingUpdateInfo.mockReturnValue({ version: '1.1.0' })
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { ...macMetadata, version: '1.2.0' }
    })
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => false
    )
    await expect(service.openDownloadedInstaller()).resolves.toMatchObject({ success: false })
    expect(mockShell.openPath).not.toHaveBeenCalled()
    expect(httpRequest).not.toHaveBeenCalled()
  })

  it('restores and verifies a pending Windows installer before notifying the UI, even with auto checks off', async () => {
    vi.useFakeTimers()
    configManagerMock.getPendingUpdateInfo.mockReturnValue({ version: '1.1.0' })
    mockAutoUpdater.checkForUpdates.mockImplementationOnce(async () => {
      mockAutoUpdater.emit('update-available', { version: '1.1.0' })
      return { isUpdateAvailable: true, updateInfo: { version: '1.1.0' } }
    })
    mockAutoUpdater.downloadUpdate.mockResolvedValue([])
    const { AppUpdateService } = await import('../AppUpdateService')
    const send = vi.fn()
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send } } as any,
      '1.0.0',
      () => false
    )
    expect(service.getState().status).toBe('checking')
    expect(send).not.toHaveBeenCalledWith('update-downloaded', expect.anything())
    service.scheduleStartupCheck(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(service.getState().status).toBe('downloaded')
    expect(send).not.toHaveBeenCalledWith('update-available', expect.anything())
    expect(send).toHaveBeenCalledWith('update-downloaded', expect.objectContaining({ version: '1.1.0' }))
    mockAutoUpdater.quitAndInstall.mockImplementation(() => mockNativeAutoUpdater.emit('before-quit-for-update'))
    await service.quitAndInstall()
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledOnce()
    vi.clearAllTimers()
  })

  it('preserves a background download and its source when the user checks again', async () => {
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => true
    )
    ;(service as any).latestUpdateInfo = { version: '1.1.0' }
    mockAutoUpdater.autoDownload = true
    mockAutoUpdater.emit('update-available', { version: '1.1.0' })
    mockAutoUpdater.emit('download-progress', { percent: 20, transferred: 20, total: 100, bytesPerSecond: 4 })
    await expect(service.checkForUpdates('manual')).resolves.toMatchObject({ status: 'downloading', source: 'auto' })
    expect(service.getState()).toMatchObject({ status: 'downloading', source: 'auto', progress: { percent: 20 } })
    expect(mockAutoUpdater.autoDownload).toBe(true)
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('never changes an active automatic download back to available after the metadata check resolves', async () => {
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => true
    )
    mockAutoUpdater.checkForUpdates.mockImplementationOnce(async () => {
      mockAutoUpdater.emit('update-available', { version: '1.1.0' })
      return { isUpdateAvailable: true, updateInfo: { version: '1.1.0' } }
    })
    await expect(service.checkForUpdates('auto')).resolves.toMatchObject({ status: 'downloading' })
    expect(service.getState().status).toBe('downloading')
  })

  it('finishes restoring an old DMG before checking and downloading the newer version', async () => {
    mockIsMac = true
    configManagerMock.getPendingUpdateInfo.mockReturnValue({ version: '1.1.0', macInstaller: macIntegrity })
    configManagerMock.setPendingUpdateInfo.mockImplementation((info) =>
      configManagerMock.getPendingUpdateInfo.mockReturnValue(info)
    )
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => false
    )
    let finishVerification!: (value: boolean) => void
    const verification = vi
      .spyOn(service as any, 'isExistingFile')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishVerification = resolve
          })
      )
      .mockResolvedValue(true)
    const restore = (service as any).ensureDownloadedUpdateReady({ version: '1.1.0', macInstaller: macIntegrity })
    await vi.waitFor(() => expect(verification).toHaveBeenCalledOnce())
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.0', files: [{ url: `Zen-AI-1.2.0-macos-${process.arch}.dmg`, ...macIntegrity }] }
    })
    const check = service.checkForUpdates('manual')
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
    finishVerification(true)
    await restore
    await expect(check).resolves.toMatchObject({ status: 'available', updateInfo: { version: '1.2.0' } })
    await expect(service.downloadUpdate()).resolves.toMatchObject({
      status: 'downloaded',
      updateInfo: { version: '1.2.0' }
    })
    expect(service.getState()).toMatchObject({ status: 'downloaded', updateInfo: { version: '1.2.0' } })
    expect(verification.mock.calls.at(-1)?.[0]).toContain('1.2.0')
  })

  it('clears an unverified old pending record when a newer manual check finishes before startup restoration', async () => {
    vi.useFakeTimers()
    mockIsMac = true
    configManagerMock.getPendingUpdateInfo.mockReturnValue({ version: '1.1.0', macInstaller: macIntegrity })
    configManagerMock.setPendingUpdateInfo.mockImplementation((info) =>
      configManagerMock.getPendingUpdateInfo.mockReturnValue(info)
    )
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => false
    )
    const verification = vi.spyOn(service as any, 'isExistingFile').mockResolvedValue(true)
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { ...macMetadata, version: '1.2.0' }
    })
    service.scheduleStartupCheck(10)
    await service.checkForUpdates('manual')
    await vi.advanceTimersByTimeAsync(10)
    expect(verification).not.toHaveBeenCalled()
    expect(configManagerMock.getPendingUpdateInfo()).toBeNull()
    expect(service.getState()).toMatchObject({ status: 'available', updateInfo: { version: '1.2.0' } })
    vi.clearAllTimers()
  })

  it('coalesces checks and waits for metadata before a requested download actually starts', async () => {
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => false
    )
    let finishCheck!: (value: any) => void
    mockAutoUpdater.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve
        })
    )
    mockAutoUpdater.downloadUpdate.mockResolvedValue([])
    const check = service.checkForUpdates('manual')
    expect(service.checkForUpdates('manual')).toBe(check)
    const download = service.downloadUpdate('manual')
    expect(service.downloadUpdate('manual')).toBe(download)
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
    finishCheck({ isUpdateAvailable: true, updateInfo: { version: '1.2.0' } })
    await expect(download).resolves.toMatchObject({ status: 'downloaded', updateInfo: { version: '1.2.0' } })
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('shares a Mac preparation flight instead of writing or verifying the same DMG twice', async () => {
    mockIsMac = true
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => false
    )
    let finishVerification!: (value: boolean) => void
    const verification = vi.spyOn(service as any, 'isExistingFile').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishVerification = resolve
        })
    )
    const first = (service as any).prepareMacManualInstaller({ version: '1.1.0', macInstaller: macIntegrity })
    const second = (service as any).prepareMacManualInstaller({ version: '1.1.0', macInstaller: macIntegrity })
    expect(second).toBe(first)
    await vi.waitFor(() => expect(verification).toHaveBeenCalledOnce())
    finishVerification(true)
    await Promise.all([first, second])
    expect(verification).toHaveBeenCalledOnce()
  })

  it('restores a cached package after a concurrent manual check fails, with automatic updates off', async () => {
    vi.useFakeTimers()
    mockIsMac = true
    configManagerMock.getPendingUpdateInfo.mockReturnValue({ version: '1.1.0', macInstaller: macIntegrity })
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => false
    )
    vi.spyOn(service as any, 'isExistingFile').mockResolvedValue(true)
    let failCheck!: (reason: Error) => void
    mockAutoUpdater.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failCheck = reject
        })
    )
    const check = service.checkForUpdates('manual')
    service.scheduleStartupCheck(10)
    await vi.advanceTimersByTimeAsync(10)
    failCheck(new Error('offline'))
    await check
    await vi.advanceTimersByTimeAsync(0)
    expect(service.getState()).toMatchObject({ status: 'downloaded', updateInfo: { version: '1.1.0' } })
    vi.clearAllTimers()
  })

  it.each(['update-available', 'update-not-available'])(
    'publishes downloaded after a transient SDK %s event during a manual recheck',
    async (eventName) => {
      const { AppUpdateService } = await import('../AppUpdateService')
      const send = vi.fn()
      const service = new AppUpdateService(
        { isDestroyed: () => false, webContents: { send } } as any,
        '1.0.0',
        () => false
      )
      mockAutoUpdater.emit('update-downloaded', { version: '1.1.0' })
      send.mockClear()
      mockAutoUpdater.checkForUpdates.mockImplementationOnce(async () => {
        mockAutoUpdater.emit(eventName, { version: '1.1.0' })
        return { isUpdateAvailable: eventName === 'update-available', updateInfo: { version: '1.1.0' } }
      })
      await expect(service.checkForUpdates('manual')).resolves.toMatchObject({ status: 'downloaded' })
      expect(send.mock.calls.at(-1)).toEqual(['update-downloaded', expect.objectContaining({ version: '1.1.0' })])
      expect(service.getState().status).toBe('downloaded')
    }
  )

  it('waits for an in-flight download before launching the installer', async () => {
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
      '1.0.0',
      () => false
    )
    await service.checkForUpdates('manual')
    let finishDownload!: (value: string[]) => void
    mockAutoUpdater.downloadUpdate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDownload = resolve
        })
    )
    mockAutoUpdater.quitAndInstall.mockImplementation(() => mockNativeAutoUpdater.emit('before-quit-for-update'))
    const download = service.downloadUpdate()
    const install = service.quitAndInstall()
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
    finishDownload([])
    await download
    await expect(install).resolves.toMatchObject({ success: true, status: 'installing' })
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('bounds a connection that never receives headers and permits a clean retry', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-dmg-timeout-'))
    try {
      const { AppUpdateService } = await import('../AppUpdateService')
      const service = new AppUpdateService(
        { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
        '1.0.0',
        () => false
      )
      const requests: any[] = []
      const payload = Buffer.from('retry payload')
      httpRequest.mockImplementation((_url, callback) => {
        const current = Object.assign(new EventEmitter(), {
          setTimeout: vi.fn(),
          destroy: vi.fn(),
          end: () => {
            if (requests.length > 1)
              queueMicrotask(() => callback(Object.assign(Readable.from([payload]), { statusCode: 200, headers: {} })))
          }
        })
        requests.push(current)
        return current
      })
      const destination = path.join(directory, 'installer.dmg')
      const first = (service as any).downloadFile('https://example.com/installer', destination)
      const failure = expect(first).rejects.toThrow('did not start responding')
      await vi.advanceTimersByTimeAsync(0)
      // Let the real filesystem unlink settle before advancing the header timer.
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(45_000)
      await failure
      expect(requests[0].destroy).toHaveBeenCalledOnce()
      await expect(readFile(`${destination}.download`)).rejects.toMatchObject({ code: 'ENOENT' })
      await (service as any).downloadFile('https://example.com/installer', destination)
      expect(await readFile(destination)).toEqual(payload)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['aborted', 'error'])('cleans up a partially received %s download before retrying', async (event) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-dmg-interrupted-'))
    try {
      const { AppUpdateService } = await import('../AppUpdateService')
      const service = new AppUpdateService(
        { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
        '1.0.0',
        () => false
      )
      let firstResponse: Readable | undefined
      let attempt = 0
      const payload = Buffer.from('complete retry')
      httpRequest.mockImplementation((_url, callback) => {
        const current = ++attempt
        const response = Object.assign(current === 1 ? new Readable({ read() {} }) : Readable.from([payload]), {
          statusCode: 200,
          headers: {}
        })
        if (current === 1) firstResponse = response
        return Object.assign(new EventEmitter(), {
          setTimeout: vi.fn(),
          destroy: vi.fn(),
          end: () =>
            queueMicrotask(() => {
              callback(response)
              if (current === 1) {
                response.push(Buffer.from('partial'))
                response.emit(event, new Error('interrupted'))
              }
            })
        })
      })
      const destination = path.join(directory, 'installer.dmg')
      await expect((service as any).downloadFile('https://example.com/installer', destination)).rejects.toThrow(
        /interrupted/
      )
      expect(firstResponse?.destroyed).toBe(true)
      await expect(readFile(`${destination}.download`)).rejects.toMatchObject({ code: 'ENOENT' })
      await (service as any).downloadFile('https://example.com/installer', destination)
      expect(await readFile(destination)).toEqual(payload)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
