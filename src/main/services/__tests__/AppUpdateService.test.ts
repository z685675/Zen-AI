import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import path from 'node:path'

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

const configManagerMock = {
  getPendingUpdateInfo: vi.fn(),
  setPendingUpdateInfo: vi.fn()
}

let mockIsMac = false

const mockApp = Object.assign(new EventEmitter(), {
  isPackaged: true,
  isQuitting: false,
  isInstallingUpdate: false
})

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
  app: mockApp,
  autoUpdater: mockNativeAutoUpdater
}))

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater
}))

describe('AppUpdateService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsMac = false
    mockApp.isQuitting = false
    mockApp.isInstallingUpdate = false
    configManagerMock.getPendingUpdateInfo.mockReturnValue(null)
    mockAutoUpdater.removeAllListeners()
    mockNativeAutoUpdater.removeAllListeners()
    mockAutoUpdater.autoDownload = true
    mockAutoUpdater.autoInstallOnAppQuit = false
    mockAutoUpdater.checkForUpdates.mockReset()
    mockAutoUpdater.downloadUpdate.mockReset()
    mockAutoUpdater.quitAndInstall.mockReset()
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
      updateInfo: null
    })
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(mockApp.isInstallingUpdate).toBe(false)
  })

  it('marks the app as installing an update before quitting', async () => {
    vi.useFakeTimers()
    mockAutoUpdater.quitAndInstall.mockImplementation(() => {
      setTimeout(() => mockApp.emit('before-quit'), 1)
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
    expect(configManagerMock.setPendingUpdateInfo).toHaveBeenCalledWith(null)
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
      setTimeout(() => mockApp.emit('before-quit'), 1)
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
    await vi.advanceTimersByTimeAsync(30000)

    await expect(installResult).resolves.toEqual({
      success: false,
      status: 'error',
      message: expect.stringContaining('Update installer did not start'),
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
      updateInfo: { version: '1.1.0' }
    })
    expect(mockApp.isInstallingUpdate).toBe(false)
    expect(mockApp.isQuitting).toBe(false)
  })

  it('keeps downloaded update pending when macOS installer does not start', async () => {
    vi.useFakeTimers()
    mockIsMac = true
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.1.0' }
    })
    mockAutoUpdater.downloadUpdate.mockResolvedValue([])

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
    const installResult = service.quitAndInstall()
    await vi.advanceTimersByTimeAsync(120000)

    await expect(installResult).resolves.toMatchObject({
      success: false,
      status: 'error',
      message: expect.stringContaining('Update installer did not start'),
      updateInfo: expect.objectContaining({ version: '1.1.0' })
    })
    expect(configManagerMock.setPendingUpdateInfo).not.toHaveBeenCalledWith(null)
    expect(mockApp.isInstallingUpdate).toBe(false)
    expect(mockApp.isQuitting).toBe(false)
  })

  it('treats native macOS before-quit-for-update as installer start', async () => {
    vi.useFakeTimers()
    mockIsMac = true
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.1.0' }
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

    ;(service as any).downloadedUpdateInfo = { version: '1.1.0' }
    const installResult = service.quitAndInstall()
    await vi.advanceTimersByTimeAsync(1)

    await expect(installResult).resolves.toEqual({
      success: true,
      status: 'installing',
      updateInfo: { version: '1.1.0' }
    })
    expect(configManagerMock.setPendingUpdateInfo).toHaveBeenCalledWith(null)
  })

  it('does not re-prepare an already downloaded macOS update in the same process', async () => {
    vi.useFakeTimers()
    mockIsMac = true
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

    const checkResult = await service.checkForUpdates('manual')
    expect(checkResult.status).toBe('downloaded')

    const installResult = service.quitAndInstall()
    await vi.advanceTimersByTimeAsync(1)

    await expect(installResult).resolves.toEqual({
      success: true,
      status: 'installing',
      updateInfo: { version: '1.1.0' }
    })
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('re-prepares macOS installer payload before installing a restored pending update', async () => {
    vi.useFakeTimers()
    mockIsMac = true
    configManagerMock.getPendingUpdateInfo.mockReturnValue({
      version: '1.1.0',
      releaseNotes: 'pending'
    })
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.1.0', releaseNotes: 'fresh' }
    })
    mockAutoUpdater.downloadUpdate.mockResolvedValue([])
    mockAutoUpdater.quitAndInstall.mockImplementation(() => {
      setTimeout(() => mockApp.emit('before-quit'), 1)
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
      updateInfo: { version: '1.1.0', releaseNotes: 'fresh' }
    })
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledOnce()
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(configManagerMock.setPendingUpdateInfo).toHaveBeenCalledWith(null)
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

  it('keeps macOS zip target configured for auto update compatibility', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const configPath = path.join(process.cwd(), 'electron-builder.yml')
    const config = fs.readFileSync(configPath, 'utf8')

    expect(config).toMatch(/^mac:\n[\s\S]*?target:\n[\s\S]*?-\s*target:\s*dmg/m)
    expect(config).toMatch(/^mac:\n[\s\S]*?target:\n[\s\S]*?-\s*target:\s*zip/m)
  })
})
