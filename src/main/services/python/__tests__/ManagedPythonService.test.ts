import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')
vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() })
  }
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => process.cwd()
  }
}))

import {
  calculateRuntimeTreeMetadata,
  MANAGED_PYTHON_RUNTIME_FORMAT,
  MANAGED_PYTHON_RUNTIME_SCHEMA_VERSION
} from '../ManagedPythonRuntimePackage'
import {
  getManagedPythonPaths,
  MANAGED_PYTHON_PACKAGES,
  MANAGED_PYTHON_PROFILE_VERSION,
  MANAGED_PYTHON_VERSION,
  ManagedPythonService
} from '../ManagedPythonService'

const tempDirs: string[] = []

async function createRuntimePackage(
  rootDir: string,
  options: { platform?: 'win32' | 'darwin'; arch?: 'x64' | 'arm64' } = {}
): Promise<string> {
  const platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'darwin')
  const arch = options.arch ?? (process.arch === 'arm64' ? 'arm64' : 'x64')
  const payloadDir = path.join(rootDir, 'package-payload')
  const runtimeDir = path.join(payloadDir, 'runtime')
  const executableRelativePath = platform === 'win32' ? 'python.exe' : 'bin/python3.12'
  const executablePath = path.join(runtimeDir, ...executableRelativePath.split('/'))
  await fs.mkdir(path.dirname(executablePath), { recursive: true })
  await fs.writeFile(executablePath, 'test-python-runtime')
  const metadata = await calculateRuntimeTreeMetadata(runtimeDir)
  const manifest = {
    format: MANAGED_PYTHON_RUNTIME_FORMAT,
    schemaVersion: MANAGED_PYTHON_RUNTIME_SCHEMA_VERSION,
    profileVersion: MANAGED_PYTHON_PROFILE_VERSION,
    pythonVersion: '3.12.12',
    platform,
    arch,
    executablePath: `runtime/${executableRelativePath}`,
    packages: MANAGED_PYTHON_PACKAGES.map((entry) => entry.id),
    ...metadata,
    createdAt: new Date().toISOString()
  }
  const packagePath = path.join(rootDir, `runtime-${platform}-${arch}.zip`)
  const zip = new AdmZip()
  zip.addLocalFolder(runtimeDir, 'runtime')
  zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'))
  zip.writeZip(packagePath)
  return packagePath
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('ManagedPythonService', () => {
  it('uses an isolated versioned environment on Windows', () => {
    const paths = getManagedPythonPaths('C:\\ZenData\\runtimes\\python', 'win32')

    expect(paths.environmentDir).toContain(`productivity-${MANAGED_PYTHON_PROFILE_VERSION}`)
    expect(paths.executablePath).toMatch(/Scripts[\\/]python\.exe$/)
    expect(paths.installationsDir).toContain('installations')
    expect(paths.cacheDir).toContain('cache')
  })

  it('uses a bin directory on Unix platforms', () => {
    const paths = getManagedPythonPaths('/tmp/zen-python', 'darwin')

    expect(paths.executablePath).toBe(`/tmp/zen-python/envs/productivity-${MANAGED_PYTHON_PROFILE_VERSION}/bin/python`)
  })

  it('reports the full productivity profile when the managed interpreter is missing', async () => {
    const rootDir = await fs.mkdtemp(path.join(tmpdir(), 'zen-managed-python-test-'))
    tempDirs.push(rootDir)
    const service = new ManagedPythonService({ rootDir, platform: 'win32' })

    const status = await service.getStatus()

    expect(status.installed).toBe(false)
    expect(status.ready).toBe(false)
    expect(status.missingPackages).toEqual(MANAGED_PYTHON_PACKAGES.map((entry) => entry.id))
    expect(await service.getAgentEnvironment()).toEqual({})
  })

  it('provisions CPython, a versioned environment, and the productivity packages', async () => {
    const rootDir = await fs.mkdtemp(path.join(tmpdir(), 'zen-managed-python-provision-'))
    tempDirs.push(rootDir)
    const paths = getManagedPythonPaths(rootDir, 'win32')
    const processRunner = vi.fn(async (_executable: string, args: string[]) => {
      if (args[0] === 'venv') {
        await fs.mkdir(path.dirname(paths.executablePath), { recursive: true })
        await fs.writeFile(paths.executablePath, '')
      }
      if (args.includes('-c')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ version: '3.12.10', missing: [] }),
          stderr: ''
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const service = new ManagedPythonService({
      rootDir,
      platform: 'win32',
      resolveUvPath: async () => 'uv-test.exe',
      processRunner
    })

    const status = await service.ensureReady()
    const calls = processRunner.mock.calls.map((call) => call[1])

    expect(status.ready).toBe(true)
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['python', 'install', MANAGED_PYTHON_VERSION, '--no-registry']),
        expect.arrayContaining(['venv', paths.environmentDir, '--clear']),
        expect.arrayContaining(['pip', 'install', '--python', paths.executablePath])
      ])
    )
    for (const packageEntry of MANAGED_PYTHON_PACKAGES) {
      expect(calls.find((args) => args[0] === 'pip')).toContain(packageEntry.requirement)
    }
  })

  it('rebuilds the private environment when its Python executable is corrupt', async () => {
    const rootDir = await fs.mkdtemp(path.join(tmpdir(), 'zen-managed-python-repair-'))
    tempDirs.push(rootDir)
    const paths = getManagedPythonPaths(rootDir, 'win32')
    await fs.mkdir(path.dirname(paths.executablePath), { recursive: true })
    await fs.writeFile(paths.executablePath, 'corrupt')
    let probeCount = 0
    const processRunner = vi.fn(async (_executable: string, args: string[]) => {
      if (args.includes('-c')) {
        probeCount++
        return probeCount === 1
          ? { exitCode: 1, stdout: '', stderr: 'invalid executable' }
          : {
              exitCode: 0,
              stdout: JSON.stringify({ version: '3.12.10', missing: [] }),
              stderr: ''
            }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const service = new ManagedPythonService({
      rootDir,
      platform: 'win32',
      resolveUvPath: async () => 'uv-test.exe',
      processRunner
    })

    const status = await service.ensureReady()

    expect(status.ready).toBe(true)
    expect(processRunner.mock.calls.map((call) => call[1])).toContainEqual(
      expect.arrayContaining(['venv', paths.environmentDir, '--clear'])
    )
  })

  it('repairs missing packages without rebuilding a healthy interpreter', async () => {
    const rootDir = await fs.mkdtemp(path.join(tmpdir(), 'zen-managed-python-packages-'))
    tempDirs.push(rootDir)
    const paths = getManagedPythonPaths(rootDir, 'win32')
    await fs.mkdir(path.dirname(paths.executablePath), { recursive: true })
    await fs.writeFile(paths.executablePath, '')
    let probeCount = 0
    const processRunner = vi.fn(async (_executable: string, args: string[]) => {
      if (args.includes('-c')) {
        probeCount++
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            version: '3.12.10',
            missing: probeCount === 1 ? ['pandas'] : []
          }),
          stderr: ''
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const service = new ManagedPythonService({
      rootDir,
      platform: 'win32',
      resolveUvPath: async () => 'uv-test.exe',
      processRunner
    })

    const status = await service.ensureReady()
    const calls = processRunner.mock.calls.map((call) => call[1])

    expect(status.ready).toBe(true)
    expect(calls.some((args) => args[0] === 'venv')).toBe(false)
    expect(calls.some((args) => args[0] === 'pip')).toBe(true)
  })

  it('imports, verifies, and activates an offline runtime package', async () => {
    const rootDir = await fs.mkdtemp(path.join(tmpdir(), 'zen-managed-python-import-'))
    tempDirs.push(rootDir)
    const platform = process.platform === 'win32' ? 'win32' : 'darwin'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const packagePath = await createRuntimePackage(rootDir, { platform, arch })
    const processRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ version: '3.12.12', missing: [] }),
      stderr: ''
    }))
    const service = new ManagedPythonService({
      rootDir,
      platform,
      arch,
      officialRuntimeBaseUrl: null,
      processRunner
    })

    const status = await service.importOfflinePackage(packagePath)

    expect(status.ready).toBe(true)
    expect(status.source).toBe('portable')
    expect(status.executablePath).toContain(path.join('portable', `productivity-${MANAGED_PYTHON_PROFILE_VERSION}`))
    expect(await fs.stat(status.executablePath)).toBeTruthy()
  })

  it('rejects an offline runtime package for a different architecture', async () => {
    const rootDir = await fs.mkdtemp(path.join(tmpdir(), 'zen-managed-python-wrong-arch-'))
    tempDirs.push(rootDir)
    const platform = process.platform === 'win32' ? 'win32' : 'darwin'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const wrongArch = arch === 'arm64' ? 'x64' : 'arm64'
    const packagePath = await createRuntimePackage(rootDir, { platform, arch: wrongArch })
    const service = new ManagedPythonService({ rootDir, platform, arch, officialRuntimeBaseUrl: null })

    await expect(service.importOfflinePackage(packagePath)).rejects.toThrow(/requires|targets/i)
  })

  it('uses the official Zen AI runtime package before uv provisioning', async () => {
    const rootDir = await fs.mkdtemp(path.join(tmpdir(), 'zen-managed-python-official-'))
    tempDirs.push(rootDir)
    const platform = process.platform === 'win32' ? 'win32' : 'darwin'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const packagePath = await createRuntimePackage(rootDir, { platform, arch })
    const runtimePackageDownloader = vi.fn(async (_url: string, destinationPath: string) => {
      await fs.copyFile(packagePath, destinationPath)
    })
    const processRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ version: '3.12.12', missing: [] }),
      stderr: ''
    }))
    const service = new ManagedPythonService({
      rootDir,
      platform,
      arch,
      officialRuntimeBaseUrl: 'https://download.example.test/zen-ai/',
      runtimePackageDownloader,
      resolveUvPath: async () => 'uv-test',
      processRunner
    })

    const status = await service.ensureReady()

    expect(status.ready).toBe(true)
    expect(status.source).toBe('portable')
    expect(runtimePackageDownloader).toHaveBeenCalledOnce()
    expect(processRunner.mock.calls.some((call) => call[0] === 'uv-test')).toBe(false)
  })

  it('falls back from the first domestic CPython mirror to the next source', async () => {
    const rootDir = await fs.mkdtemp(path.join(tmpdir(), 'zen-managed-python-mirror-'))
    tempDirs.push(rootDir)
    const paths = getManagedPythonPaths(rootDir, 'win32')
    let pythonInstallAttempts = 0
    const processRunner = vi.fn(async (_executable: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      if (args[0] === 'python' && args[1] === 'install') {
        pythonInstallAttempts++
        if (pythonInstallAttempts === 1) return { exitCode: 1, stdout: '', stderr: 'mirror unavailable' }
      }
      if (args[0] === 'venv') {
        await fs.mkdir(path.dirname(paths.executablePath), { recursive: true })
        await fs.writeFile(paths.executablePath, '')
      }
      if (args.includes('-c')) {
        return { exitCode: 0, stdout: JSON.stringify({ version: '3.12.12', missing: [] }), stderr: '' }
      }
      expect(options.env).toBeTruthy()
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const service = new ManagedPythonService({
      rootDir,
      platform: 'win32',
      arch: 'x64',
      officialRuntimeBaseUrl: null,
      resolveUvPath: async () => 'uv-test.exe',
      processRunner
    })

    const status = await service.ensureReady()
    const installCalls = processRunner.mock.calls.filter((call) => call[1][0] === 'python')

    expect(status.ready).toBe(true)
    expect(installCalls).toHaveLength(2)
    expect(installCalls[0][2].env?.UV_PYTHON_INSTALL_MIRROR).toContain('aliyun.com')
    expect(installCalls[1][2].env?.UV_PYTHON_INSTALL_MIRROR).toContain('ustc.edu.cn')
  })
})
