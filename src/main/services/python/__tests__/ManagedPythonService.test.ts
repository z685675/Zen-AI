import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
  getManagedPythonPaths,
  MANAGED_PYTHON_PACKAGES,
  MANAGED_PYTHON_PROFILE_VERSION,
  MANAGED_PYTHON_VERSION,
  ManagedPythonService
} from '../ManagedPythonService'

const tempDirs: string[] = []

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
})
