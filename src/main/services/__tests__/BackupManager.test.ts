import type * as PathModule from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock path module to normalize all paths to POSIX format for cross-platform consistency
// This ensures path operations work the same way regardless of the actual OS
vi.mock('path', async () => {
  const actual: typeof PathModule = await vi.importActual('path')
  return {
    ...actual,
    sep: '/', // Always use forward slash for consistency
    delimiter: ':',
    join: (...args: string[]) => {
      // Join with forward slashes, normalizing away backslashes
      return actual.join(...args).replace(/\\/g, '/')
    },
    normalize: (p: string) => {
      // Normalize path separators and remove redundant slashes
      return actual.normalize(p).replace(/\\/g, '/')
    },
    resolve: (...args: string[]) => {
      // For paths starting with / (Unix-style), use posix.resolve to avoid drive letter prefix
      if (args.some((arg) => typeof arg === 'string' && arg.startsWith('/'))) {
        return actual.posix.resolve(...args.map((a) => String(a).replace(/\\/g, '/')))
      }
      // For relative or Windows paths, use native resolve
      return actual.resolve(...args).replace(/\\/g, '/')
    },
    isAbsolute: (p: string) => actual.isAbsolute(p) || String(p).startsWith('/'),
    dirname: (p: string) => actual.dirname(p).replace(/\\/g, '/'),
    basename: actual.basename,
    extname: actual.extname,
    relative: (from: string, to: string) =>
      actual.relative(from.replace(/\\/g, '/'), to.replace(/\\/g, '/')).replace(/\\/g, '/'),
    // Keep native POSIX and win32 for direct use if needed
    posix: actual.posix,
    win32: actual.win32
  }
})

// Use vi.hoisted to define mocks that are available during hoisting
const {
  mockBackupPathMigrationService,
  mockLogger,
  mockDataGuard,
  mockCommitted,
  mockStage,
  mockExtract,
  mockZipClose,
  mockRelaunch,
  mockExit
} = vi.hoisted(() => ({
  mockDataGuard: vi.fn(async (_kind: string, work: () => Promise<unknown>) => work()),
  mockCommitted: vi.fn(),
  mockStage: vi.fn(),
  mockExtract: vi.fn(),
  mockZipClose: vi.fn(),
  mockRelaunch: vi.fn(),
  mockExit: vi.fn(),
  mockBackupPathMigrationService: {
    hasMigrationMarker: vi.fn(),
    migrateRestoredInternalPaths: vi.fn()
  },
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => mockLogger
  }
}))

vi.mock('electron', () => ({
  app: {
    relaunch: mockRelaunch,
    exit: mockExit,
    getPath: vi.fn((key: string) => {
      if (key === 'temp') return '/tmp'
      if (key === 'userData') return '/mock/userData'
      return '/mock/unknown'
    })
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({ isEmpty: () => false }))
  }
}))

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    remove: vi.fn(),
    ensureDir: vi.fn(),
    copy: vi.fn(),
    rename: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    createWriteStream: vi.fn(),
    createReadStream: vi.fn()
  },
  pathExists: vi.fn(),
  remove: vi.fn(),
  ensureDir: vi.fn(),
  copy: vi.fn(),
  rename: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  readJson: vi.fn(),
  writeFile: vi.fn(),
  createWriteStream: vi.fn(),
  createReadStream: vi.fn()
}))

vi.mock('../WindowService', () => ({
  windowService: {
    getMainWindow: vi.fn()
  }
}))

vi.mock('../WebDav', () => ({
  default: vi.fn()
}))

vi.mock('../S3Storage', () => ({
  default: vi.fn()
}))

vi.mock('../../utils', () => ({
  getDataPath: vi.fn(() => '/mock/data')
}))

vi.mock('../BackupPathMigrationService', () => ({
  BackupPathMigrationService: mockBackupPathMigrationService
}))

vi.mock('archiver', () => ({
  default: vi.fn()
}))

vi.mock('node-stream-zip', () => ({
  default: {
    async: vi.fn(function () {
      return { extract: mockExtract, close: mockZipClose }
    })
  }
}))
vi.mock('../AssistantDataOperationService', () => ({
  withAssistantDataOperation: mockDataGuard,
  markRendererDataCommitted: mockCommitted,
  registerRendererDataStage: vi.fn()
}))
vi.mock('../AssistantBackupSnapshot', () => ({ copyAssistantBackupData: vi.fn(), stageAssistantBackupData: mockStage }))
vi.mock('../SelectionService', () => ({ default: { quit: vi.fn() } }))

// Import after mocks
import { APP_NAME, APP_TEMP_DIR_NAME } from '@shared/config/constant'
import * as fs from 'fs-extra'

import BackupManager from '../BackupManager'

const lanTransferTempDir = `/tmp/${APP_TEMP_DIR_NAME}/lan-transfer`

describe('BackupManager.deleteLanTransferBackup - Security Tests', () => {
  let backupManager: BackupManager

  beforeEach(() => {
    vi.clearAllMocks()
    backupManager = new BackupManager()
  })

  describe('Normal Operations', () => {
    it('should delete valid file in allowed directory', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true as never)
      vi.mocked(fs.remove).mockResolvedValue(undefined as never)

      const validPath = `${lanTransferTempDir}/backup.zip`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, validPath)

      expect(result).toBe(true)
      expect(fs.remove).toHaveBeenCalledWith(validPath)
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Deleted temp backup'))
    })

    it('should delete file in nested subdirectory', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true as never)
      vi.mocked(fs.remove).mockResolvedValue(undefined as never)

      const nestedPath = `${lanTransferTempDir}/sub/dir/file.zip`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, nestedPath)

      expect(result).toBe(true)
      expect(fs.remove).toHaveBeenCalledWith(nestedPath)
    })

    it('should return false when file does not exist', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false as never)

      const missingPath = `${lanTransferTempDir}/missing.zip`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, missingPath)

      expect(result).toBe(false)
      expect(fs.remove).not.toHaveBeenCalled()
    })
  })

  describe('Path Traversal Attacks', () => {
    it('should block basic directory traversal attack (../../../../etc/passwd)', async () => {
      const attackPath = `${lanTransferTempDir}/../../../../etc/passwd`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, attackPath)

      expect(result).toBe(false)
      expect(fs.pathExists).not.toHaveBeenCalled()
      expect(fs.remove).not.toHaveBeenCalled()
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('outside temp directory'))
    })

    it('should block absolute path escape (/etc/passwd)', async () => {
      const attackPath = '/etc/passwd'
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, attackPath)

      expect(result).toBe(false)
      expect(fs.remove).not.toHaveBeenCalled()
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it('should block traversal with multiple slashes', async () => {
      const attackPath = `${lanTransferTempDir}/../../../etc/passwd`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, attackPath)

      expect(result).toBe(false)
      expect(fs.remove).not.toHaveBeenCalled()
    })

    it('should block relative path traversal from current directory', async () => {
      const attackPath = '../../../etc/passwd'
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, attackPath)

      expect(result).toBe(false)
      expect(fs.remove).not.toHaveBeenCalled()
    })

    it('should block traversal to parent directory', async () => {
      const attackPath = `${lanTransferTempDir}/../backup/secret.zip`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, attackPath)

      expect(result).toBe(false)
      expect(fs.remove).not.toHaveBeenCalled()
    })
  })

  describe('Prefix Attacks', () => {
    it('should block similar prefix attack (lan-transfer-evil)', async () => {
      const attackPath = `/tmp/${APP_TEMP_DIR_NAME}/lan-transfer-evil/file.zip`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, attackPath)

      expect(result).toBe(false)
      expect(fs.remove).not.toHaveBeenCalled()
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it('should block path without separator (lan-transferx)', async () => {
      const attackPath = `/tmp/${APP_TEMP_DIR_NAME}/lan-transferx`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, attackPath)

      expect(result).toBe(false)
      expect(fs.remove).not.toHaveBeenCalled()
    })

    it('should block different temp directory prefix', async () => {
      const attackPath = `/tmp-evil/${APP_TEMP_DIR_NAME}/lan-transfer/file.zip`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, attackPath)

      expect(result).toBe(false)
      expect(fs.remove).not.toHaveBeenCalled()
    })
  })

  describe('Error Handling', () => {
    it('should return false and log error on permission denied', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true as never)
      vi.mocked(fs.remove).mockRejectedValue(new Error('EACCES: permission denied') as never)

      const validPath = `${lanTransferTempDir}/file.zip`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, validPath)

      expect(result).toBe(false)
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to delete'), expect.any(Error))
    })

    it('should return false on fs.pathExists error', async () => {
      vi.mocked(fs.pathExists).mockRejectedValue(new Error('ENOENT') as never)

      const validPath = `${lanTransferTempDir}/file.zip`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, validPath)

      expect(result).toBe(false)
      expect(mockLogger.error).toHaveBeenCalled()
    })

    it('should handle empty path string', async () => {
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, '')

      expect(result).toBe(false)
      expect(fs.remove).not.toHaveBeenCalled()
    })
  })

  describe('Edge Cases', () => {
    it('should allow deletion of the temp directory itself', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true as never)
      vi.mocked(fs.remove).mockResolvedValue(undefined as never)

      const tempDir = lanTransferTempDir
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, tempDir)

      expect(result).toBe(true)
      expect(fs.remove).toHaveBeenCalledWith(tempDir)
    })

    it('should handle path with trailing slash', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true as never)
      vi.mocked(fs.remove).mockResolvedValue(undefined as never)

      const pathWithSlash = `${lanTransferTempDir}/sub/`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, pathWithSlash)

      // path.normalize removes trailing slash
      expect(result).toBe(true)
    })

    it('should handle file with special characters in name', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true as never)
      vi.mocked(fs.remove).mockResolvedValue(undefined as never)

      const specialPath = `${lanTransferTempDir}/file with spaces & (special).zip`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, specialPath)

      expect(result).toBe(true)
      expect(fs.remove).toHaveBeenCalled()
    })

    it('should handle path with double slashes', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true as never)
      vi.mocked(fs.remove).mockResolvedValue(undefined as never)

      const doubleSlashPath = `/tmp/${APP_TEMP_DIR_NAME}//lan-transfer//file.zip`
      const result = await backupManager.deleteLanTransferBackup({} as Electron.IpcMainInvokeEvent, doubleSlashPath)

      // path.normalize handles double slashes
      expect(result).toBe(true)
    })
  })
})

describe('BackupManager.handleStartupRestore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBackupPathMigrationService.hasMigrationMarker.mockResolvedValue(true)
    mockBackupPathMigrationService.migrateRestoredInternalPaths.mockResolvedValue(undefined)
    vi.mocked(fs.remove).mockResolvedValue(undefined as never)
    vi.mocked(fs.rename).mockResolvedValue(undefined as never)
  })

  it('skips internal path migration when no restore marker exists and migration already ran', async () => {
    vi.mocked(fs.pathExists).mockResolvedValue(false as never)

    await BackupManager.handleStartupRestore()

    expect(mockBackupPathMigrationService.hasMigrationMarker).toHaveBeenCalled()
    expect(mockBackupPathMigrationService.migrateRestoredInternalPaths).not.toHaveBeenCalled()
  })

  it('runs internal path migration once when no restore marker exists but migration marker is missing', async () => {
    vi.mocked(fs.pathExists).mockResolvedValue(false as never)
    mockBackupPathMigrationService.hasMigrationMarker.mockResolvedValue(false)

    await BackupManager.handleStartupRestore()

    expect(mockBackupPathMigrationService.migrateRestoredInternalPaths).toHaveBeenCalledWith({
      removeWeChatCredentials: false
    })
  })

  it('restores pending directories and runs internal path migration after a restore', async () => {
    vi.mocked(fs.pathExists).mockImplementation(async (target) => String(target).endsWith('.restore') as never)

    await BackupManager.handleStartupRestore()

    expect(fs.remove).not.toHaveBeenCalledWith('/mock/userData/IndexedDB')
    expect(fs.rename).toHaveBeenCalledWith('/mock/userData/IndexedDB.restore', '/mock/userData/IndexedDB')
    expect(fs.remove).not.toHaveBeenCalledWith('/mock/userData/Local Storage')
    expect(fs.rename).toHaveBeenCalledWith('/mock/userData/Local Storage.restore', '/mock/userData/Local Storage')
    expect(fs.remove).not.toHaveBeenCalledWith('/mock/data')
    expect(fs.rename).toHaveBeenCalledWith('/mock/data.restore', '/mock/data')
    expect(mockBackupPathMigrationService.hasMigrationMarker).not.toHaveBeenCalled()
    expect(mockBackupPathMigrationService.migrateRestoredInternalPaths).toHaveBeenCalledWith({
      removeWeChatCredentials: true
    })
  })
  it('returns a saved original directory after a failed startup swap instead of deleting history', async () => {
    vi.mocked(fs.pathExists).mockResolvedValue(true as never)
    vi.mocked(fs.rename).mockImplementation(async (source) => {
      if (String(source) === '/mock/userData/IndexedDB.restore') throw new Error('locked')
    })
    await BackupManager.handleStartupRestore()
    expect(fs.rename).toHaveBeenCalledWith(
      '/mock/userData/IndexedDB',
      expect.stringContaining('/mock/userData/IndexedDB.before-restore-')
    )
    expect(fs.rename).toHaveBeenCalledWith(
      expect.stringContaining('/mock/userData/IndexedDB.before-restore-'),
      '/mock/userData/IndexedDB'
    )
    expect(fs.remove).not.toHaveBeenCalled()
    expect(mockBackupPathMigrationService.migrateRestoredInternalPaths).not.toHaveBeenCalled()
  })
})

describe('BackupManager protected restore staging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDataGuard.mockImplementation(async (_kind, work) => work())
    mockStage.mockResolvedValue(undefined)
    mockExtract.mockResolvedValue(undefined)
    mockZipClose.mockResolvedValue(undefined)
    mockRelaunch.mockReset()
    vi.mocked(fs.pathExists).mockResolvedValue(true as never)
    vi.mocked(fs.remove).mockResolvedValue(undefined as never)
    vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
    vi.mocked(fs.copy).mockResolvedValue(undefined as never)
    vi.mocked(fs.readdir).mockResolvedValue(['agents.db'] as never)
    vi.mocked(fs.readJson).mockResolvedValue({ appName: APP_NAME, version: 6, dataMode: 'slim' })
  })
  it('blocks restore and reset before touching files if data admission is refused', async () => {
    mockDataGuard.mockRejectedValueOnce(new Error('busy'))
    await expect(new BackupManager().restore({} as any, '/backup.zip')).rejects.toThrow('busy')
    expect(mockExtract).not.toHaveBeenCalled()
    expect(fs.remove).not.toHaveBeenCalled()
    mockDataGuard.mockRejectedValueOnce(new Error('busy'))
    await expect(new BackupManager().resetData()).rejects.toThrow('busy')
    expect(fs.ensureDir).not.toHaveBeenCalled()
  })
  it.each(['slim', 'full'])('stages %s native history and never replaces live data before restart', async (mode) => {
    vi.mocked(fs.readJson).mockResolvedValue({ appName: APP_NAME, version: 6, dataMode: mode })
    await new BackupManager().restore({ sender: { id: 4 } } as any, '/backup.zip')
    expect(mockStage).toHaveBeenCalledWith(
      expect.stringContaining('/Data'),
      '/mock/userData/Data',
      '/mock/userData/Data.restore',
      mode === 'slim'
    )
    expect(fs.remove).not.toHaveBeenCalledWith('/mock/userData/Data')
    expect(mockZipClose).toHaveBeenCalledOnce()
    expect(mockRelaunch.mock.invocationCallOrder[0]).toBeLessThan(mockCommitted.mock.invocationCallOrder[0])
    expect(mockExit).toHaveBeenCalledExactlyOnceWith(0)
  })
  it('clears only staged paths and does not commit when relaunch fails', async () => {
    mockRelaunch.mockImplementationOnce(() => {
      throw new Error('relaunch failed')
    })
    await expect(new BackupManager().restore({ sender: { id: 4 } } as any, '/backup.zip')).rejects.toThrow(
      'relaunch failed'
    )
    for (const folder of ['IndexedDB', 'Local Storage', 'Data'])
      expect(fs.remove).toHaveBeenCalledWith(`/mock/userData/${folder}.restore`)
    expect(fs.remove).not.toHaveBeenCalledWith('/mock/userData/Data')
    expect(mockCommitted).not.toHaveBeenCalled()
    expect(mockExit).not.toHaveBeenCalled()
  })
  it('closes the zip on extraction failure without preparing restore markers', async () => {
    mockExtract.mockRejectedValueOnce(new Error('invalid zip'))
    await expect(new BackupManager().restore({} as any, '/backup.zip')).rejects.toThrow('invalid zip')
    expect(mockZipClose).toHaveBeenCalledOnce()
    expect(mockStage).not.toHaveBeenCalled()
    expect(mockRelaunch).not.toHaveBeenCalled()
    expect(fs.remove).not.toHaveBeenCalledWith('/mock/userData/Data.restore')
  })
})
