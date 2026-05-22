import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockAutoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: false,
  allowPrerelease: false,
  allowDowngrade: false,
  logger: undefined as unknown,
  setFeedURL: vi.fn(),
  on: vi.fn(),
  quitAndInstall: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn()
}

const configManagerMock = {
  getPendingUpdateInfo: vi.fn(),
  setPendingUpdateInfo: vi.fn()
}

const mockApp = {
  isPackaged: true,
  isQuitting: false,
  isInstallingUpdate: false
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
  isPortable: false
}))

vi.mock('@main/services/ConfigManager', () => ({
  configManager: configManagerMock
}))

vi.mock('@shared/config/constant', () => ({
  APP_NAME: 'Zen-AI',
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
  app: mockApp
}))

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater
}))

describe('AppUpdateService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApp.isQuitting = false
    mockApp.isInstallingUpdate = false
    configManagerMock.getPendingUpdateInfo.mockReturnValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns false when no downloaded update is available', async () => {
    const { AppUpdateService } = await import('../AppUpdateService')
    const service = new AppUpdateService(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any,
      '1.0.0',
      () => true
    )

    expect(service.quitAndInstall()).toBe(false)
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(mockApp.isInstallingUpdate).toBe(false)
  })

  it('marks the app as installing an update before quitting', async () => {
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

    expect(service.quitAndInstall()).toBe(true)
    expect(configManagerMock.setPendingUpdateInfo).toHaveBeenCalledWith(null)
    expect(mockApp.isInstallingUpdate).toBe(true)
    expect(mockApp.isQuitting).toBe(true)
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('restores downloaded update state from pending config on startup', async () => {
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

    expect(service.getState().status).toBe('downloaded')
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
})
