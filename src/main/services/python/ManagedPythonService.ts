import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { loggerService } from '@logger'
import { getProxyEnvironment } from '@main/services/proxy/nodeProxy'
import { findExecutableInEnv, getBinaryPath, isBinaryExists } from '@main/utils/process'
import { app, net } from 'electron'

import {
  MANAGED_PYTHON_PACKAGES,
  MANAGED_PYTHON_PROFILE_VERSION,
  MANAGED_PYTHON_VERSION,
  type ManagedPythonPackageId
} from './ManagedPythonConfig'
import {
  extractManagedPythonRuntimePackage,
  getManagedPythonRuntimeAssetName,
  MANAGED_PYTHON_INSTALLED_MANIFEST,
  type ManagedPythonRuntimeManifest,
  validateManagedPythonRuntimeManifest
} from './ManagedPythonRuntimePackage'

const logger = loggerService.withContext('ManagedPythonService')

export {
  MANAGED_PYTHON_PACKAGES,
  MANAGED_PYTHON_PROFILE_VERSION,
  MANAGED_PYTHON_VERSION,
  type ManagedPythonPackageId
} from './ManagedPythonConfig'

export interface ManagedPythonPaths {
  rootDir: string
  installationsDir: string
  cacheDir: string
  environmentDir: string
  executablePath: string
  binDir: string
  portableDir: string
  portableManifestPath: string
}

export interface ManagedPythonStatus {
  installed: boolean
  ready: boolean
  version?: string
  executablePath: string
  environmentPath: string
  missingPackages: ManagedPythonPackageId[]
  packageProfileVersion: string
  source?: 'portable' | 'managed'
  message?: string
}

export interface ManagedPythonExecutionResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface ProcessRunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes?: number
}

type ProcessRunner = (executable: string, args: string[], options: ProcessRunOptions) => Promise<ProcessResult>

interface ManagedPythonServiceOptions {
  rootDir?: string
  platform?: NodeJS.Platform
  arch?: string
  resolveUvPath?: () => Promise<string | null>
  processRunner?: ProcessRunner
  officialRuntimeBaseUrl?: string | null
  runtimePackageDownloader?: (url: string, destinationPath: string) => Promise<void>
}

const INSTALL_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_EXECUTION_TIMEOUT_MS = 2 * 60 * 1000
const MAX_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024
const MAX_RUNTIME_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
const RUNTIME_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000
const OFFICIAL_RUNTIME_BASE_URL = 'https://download.925636.xyz/zen-ai/'
const ALIYUN_PYTHON_INSTALL_MIRROR = 'https://mirrors.aliyun.com/github/releases/astral-sh/python-build-standalone'
const USTC_PYTHON_INSTALL_MIRROR = 'https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone/'
const USTC_PYPI_INDEX = 'https://mirrors.ustc.edu.cn/pypi/simple'

interface ManagedPythonRuntimeLocation {
  environmentDir: string
  executablePath: string
  binDir: string
  source: 'portable' | 'managed'
}

export function getManagedPythonPaths(
  rootDir: string,
  platform: NodeJS.Platform = process.platform
): ManagedPythonPaths {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const environmentDir = pathApi.join(rootDir, 'envs', `productivity-${MANAGED_PYTHON_PROFILE_VERSION}`)
  const binDir = platform === 'win32' ? pathApi.join(environmentDir, 'Scripts') : pathApi.join(environmentDir, 'bin')
  const executablePath = pathApi.join(binDir, platform === 'win32' ? 'python.exe' : 'python')
  const portableDir = pathApi.join(rootDir, 'portable', `productivity-${MANAGED_PYTHON_PROFILE_VERSION}`)

  return {
    rootDir,
    installationsDir: pathApi.join(rootDir, 'installations'),
    cacheDir: pathApi.join(rootDir, 'cache'),
    environmentDir,
    executablePath,
    binDir,
    portableDir,
    portableManifestPath: pathApi.join(portableDir, MANAGED_PYTHON_INSTALLED_MANIFEST)
  }
}

function buildSanitizedExecutionEnv(
  runtime: ManagedPythonRuntimeLocation,
  rootDir: string,
  sourceEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const allowedKeys = [
    'APPDATA',
    'COMSPEC',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LANG',
    'LC_ALL',
    'LOCALAPPDATA',
    'PATH',
    'Path',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'WINDIR'
  ]
  const env: NodeJS.ProcessEnv = {}

  for (const key of allowedKeys) {
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key]
    }
  }

  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = [runtime.binDir, env[pathKey]].filter(Boolean).join(path.delimiter)
  env.VIRTUAL_ENV = runtime.environmentDir
  env.PYTHONNOUSERSITE = '1'
  env.PYTHONDONTWRITEBYTECODE = '1'
  env.PYTHONUTF8 = '1'
  env.ZEN_PYTHON_EXECUTABLE = runtime.executablePath
  env.ZEN_PYTHON_HOME = rootDir

  return env
}

function buildProvisioningEnv(
  paths: ManagedPythonPaths,
  options: { pythonInstallMirror?: string; nativeTls?: boolean } = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...getProxyEnvironment(process.env),
    UV_CACHE_DIR: paths.cacheDir,
    UV_MANAGED_PYTHON: '1',
    UV_NO_PROGRESS: '1',
    UV_PYTHON_DOWNLOADS: 'automatic',
    UV_PYTHON_INSTALL_DIR: paths.installationsDir
  }

  delete env.UV_NATIVE_TLS
  delete env.UV_PYTHON_INSTALL_MIRROR
  if (options.nativeTls) env.UV_NATIVE_TLS = '1'
  if (options.pythonInstallMirror) env.UV_PYTHON_INSTALL_MIRROR = options.pythonInstallMirror
  return env
}

async function downloadRuntimePackage(url: string, destinationPath: string): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RUNTIME_DOWNLOAD_TIMEOUT_MS)

  try {
    const response = await net.fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`Runtime download returned HTTP ${response.status}`)

    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > MAX_RUNTIME_DOWNLOAD_BYTES) throw new Error('Runtime download is too large')
    if (!response.body) throw new Error('Runtime download returned an empty response')

    let receivedBytes = 0
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length
        if (receivedBytes > MAX_RUNTIME_DOWNLOAD_BYTES) {
          callback(new Error('Runtime download exceeded the allowed size'))
          return
        }
        callback(null, chunk)
      }
    })

    const body = response.body as unknown as Parameters<typeof Readable.fromWeb>[0]
    await pipeline(Readable.fromWeb(body), limiter, fs.createWriteStream(destinationPath, { flags: 'wx' }))
  } finally {
    clearTimeout(timeout)
  }
}

function clampTimeout(timeoutMs?: number): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_EXECUTION_TIMEOUT_MS
  return Math.min(Math.max(Math.round(timeoutMs!), 1000), MAX_EXECUTION_TIMEOUT_MS)
}

async function runProcess(executable: string, args: string[], options: ProcessRunOptions): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const maxOutputBytes = options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback()
    }

    const appendOutput = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8')
      if (Buffer.byteLength(next, 'utf8') > maxOutputBytes) {
        child.kill()
        finish(() => reject(new Error(`Process output exceeded ${maxOutputBytes} bytes`)))
        return current
      }
      return next
    }

    const timeout = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error(`Process timed out after ${options.timeoutMs}ms`)))
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk)
    })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) =>
      finish(() =>
        resolve({
          exitCode: code ?? -1,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        })
      )
    )
  })
}

export class ManagedPythonService {
  private readonly rootDirOverride?: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly resolveUvPathOverride?: () => Promise<string | null>
  private readonly processRunner: ProcessRunner
  private readonly officialRuntimeBaseUrl: string | null
  private readonly runtimePackageDownloader: (url: string, destinationPath: string) => Promise<void>
  private preparePromise: Promise<ManagedPythonStatus> | null = null

  constructor(options: ManagedPythonServiceOptions = {}) {
    this.rootDirOverride = options.rootDir
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.resolveUvPathOverride = options.resolveUvPath
    this.processRunner = options.processRunner ?? runProcess
    this.officialRuntimeBaseUrl =
      options.officialRuntimeBaseUrl === undefined ? OFFICIAL_RUNTIME_BASE_URL : options.officialRuntimeBaseUrl
    this.runtimePackageDownloader = options.runtimePackageDownloader ?? downloadRuntimePackage
  }

  getPaths(): ManagedPythonPaths {
    const rootDir = this.rootDirOverride ?? path.join(app.getPath('userData'), 'runtimes', 'python')
    return getManagedPythonPaths(rootDir, this.platform)
  }

  async getStatus(): Promise<ManagedPythonStatus> {
    const paths = this.getPaths()
    const portable = await this.getPortableRuntime(paths)
    let portableStatus = portable instanceof Error ? this.invalidPortableStatus(paths, portable) : null
    if (portable && !(portable instanceof Error)) {
      portableStatus = await this.probeRuntime(portable)
      if (portableStatus.ready) return portableStatus
    }

    const managed: ManagedPythonRuntimeLocation = {
      environmentDir: paths.environmentDir,
      executablePath: paths.executablePath,
      binDir: paths.binDir,
      source: 'managed'
    }
    const managedStatus = await this.probeRuntime(managed)
    if (managedStatus.ready) return managedStatus
    return portableStatus?.installed ? portableStatus : managedStatus
  }

  private async probeRuntime(runtime: ManagedPythonRuntimeLocation): Promise<ManagedPythonStatus> {
    const paths = this.getPaths()
    if (!fs.existsSync(runtime.executablePath)) {
      return {
        installed: false,
        ready: false,
        executablePath: runtime.executablePath,
        environmentPath: runtime.environmentDir,
        missingPackages: MANAGED_PYTHON_PACKAGES.map((entry) => entry.id),
        packageProfileVersion: MANAGED_PYTHON_PROFILE_VERSION,
        source: runtime.source
      }
    }

    const probe = [
      'import importlib.util, json, sys',
      `packages = ${JSON.stringify(MANAGED_PYTHON_PACKAGES.map(({ id, importName }) => ({ id, importName })))}`,
      "missing = [p['id'] for p in packages if importlib.util.find_spec(p['importName']) is None]",
      "print(json.dumps({'version': '.'.join(map(str, sys.version_info[:3])), 'missing': missing}))"
    ].join('; ')

    try {
      const result = await this.processRunner(runtime.executablePath, ['-I', '-X', 'utf8', '-c', probe], {
        env: buildSanitizedExecutionEnv(runtime, paths.rootDir),
        timeoutMs: 20_000
      })
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `Python probe exited with code ${result.exitCode}`)
      }

      const parsed = JSON.parse(result.stdout) as { version?: string; missing?: ManagedPythonPackageId[] }
      const missingPackages = Array.isArray(parsed.missing) ? parsed.missing : []

      return {
        installed: true,
        ready: missingPackages.length === 0,
        version: parsed.version,
        executablePath: runtime.executablePath,
        environmentPath: runtime.environmentDir,
        missingPackages,
        packageProfileVersion: MANAGED_PYTHON_PROFILE_VERSION,
        source: runtime.source
      }
    } catch (error) {
      return {
        installed: true,
        ready: false,
        executablePath: runtime.executablePath,
        environmentPath: runtime.environmentDir,
        missingPackages: MANAGED_PYTHON_PACKAGES.map((entry) => entry.id),
        packageProfileVersion: MANAGED_PYTHON_PROFILE_VERSION,
        source: runtime.source,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async ensureReady(): Promise<ManagedPythonStatus> {
    if (this.preparePromise) return await this.preparePromise

    this.preparePromise = this.prepare().finally(() => {
      this.preparePromise = null
    })
    return await this.preparePromise
  }

  async importOfflinePackage(packagePath: string): Promise<ManagedPythonStatus> {
    if (!packagePath.trim()) throw new Error('Python runtime package path is required')
    if (this.preparePromise) await this.preparePromise.catch(() => undefined)
    return await this.installRuntimePackage(packagePath)
  }

  async execute(code: string, options?: { cwd?: string; timeoutMs?: number }): Promise<ManagedPythonExecutionResult> {
    if (!code.trim()) throw new Error('Python code is required')

    return await this.executeArguments(['-I', '-X', 'utf8', '-c', code], options)
  }

  async executeScript(
    scriptPath: string,
    args: string[] = [],
    options?: { cwd?: string; timeoutMs?: number }
  ): Promise<ManagedPythonExecutionResult> {
    if (!scriptPath.trim()) throw new Error('Python script path is required')
    if (args.some((arg) => typeof arg !== 'string')) throw new Error('Python script arguments must be strings')

    return await this.executeArguments(['-E', '-s', '-X', 'utf8', scriptPath, ...args], options)
  }

  private async executeArguments(
    pythonArgs: string[],
    options?: { cwd?: string; timeoutMs?: number }
  ): Promise<ManagedPythonExecutionResult> {
    const status = await this.getStatus()
    if (!status.ready) {
      throw new Error(
        status.message ||
          `Zen AI managed Python is not ready. Missing packages: ${status.missingPackages.join(', ') || 'unknown'}`
      )
    }

    const paths = this.getPaths()
    const runtime = this.runtimeFromStatus(status)
    const cwd = options?.cwd ? path.resolve(options.cwd) : paths.rootDir
    const stat = await fsp.stat(cwd).catch(() => null)
    if (!stat?.isDirectory()) throw new Error(`Python working directory does not exist: ${cwd}`)

    const startedAt = Date.now()
    const result = await this.processRunner(runtime.executablePath, pythonArgs, {
      cwd,
      env: buildSanitizedExecutionEnv(runtime, paths.rootDir),
      timeoutMs: clampTimeout(options?.timeoutMs)
    })

    return {
      ...result,
      durationMs: Date.now() - startedAt
    }
  }

  async getAgentEnvironment(sourceEnv: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
    const status = await this.getStatus()
    if (!status.ready) return {}

    const paths = this.getPaths()
    const env = buildSanitizedExecutionEnv(this.runtimeFromStatus(status), paths.rootDir, sourceEnv)
    return Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
  }

  private async prepare(): Promise<ManagedPythonStatus> {
    const existing = await this.getStatus()
    if (existing.ready) return existing

    const paths = this.getPaths()
    const officialRuntime = await this.tryInstallOfficialRuntime(paths)
    if (officialRuntime?.ready) return officialRuntime

    const uvPath = await this.resolveUvPath()
    if (!uvPath) throw new Error('UV is required before Zen AI managed Python can be prepared')

    await Promise.all([
      fsp.mkdir(paths.installationsDir, { recursive: true }),
      fsp.mkdir(paths.cacheDir, { recursive: true }),
      fsp.mkdir(path.dirname(paths.environmentDir), { recursive: true })
    ])

    logger.info('Preparing Zen AI managed Python', {
      version: MANAGED_PYTHON_VERSION,
      environmentPath: paths.environmentDir,
      packageCount: MANAGED_PYTHON_PACKAGES.length
    })

    const installPythonArgs = [
      'python',
      'install',
      MANAGED_PYTHON_VERSION,
      '--install-dir',
      paths.installationsDir,
      '--no-bin',
      '--no-registry',
      '--managed-python'
    ]
    await this.runUvWithFallback(uvPath, installPythonArgs, paths, 'Python runtime download', [
      { name: 'Aliyun mirror', pythonInstallMirror: ALIYUN_PYTHON_INSTALL_MIRROR },
      { name: 'USTC mirror', pythonInstallMirror: USTC_PYTHON_INSTALL_MIRROR },
      { name: 'official source' },
      { name: 'official source with system certificates', nativeTls: true }
    ])

    const hasExpectedVersion =
      existing.version === MANAGED_PYTHON_VERSION || existing.version?.startsWith(`${MANAGED_PYTHON_VERSION}.`)
    const shouldRecreateEnvironment =
      !fs.existsSync(paths.executablePath) || Boolean(existing.message) || !hasExpectedVersion

    if (shouldRecreateEnvironment) {
      if (existing.installed) {
        logger.warn('Rebuilding an invalid Zen AI managed Python environment', {
          environmentPath: paths.environmentDir,
          detectedVersion: existing.version,
          reason: existing.message || 'unexpected Python version'
        })
      }

      const createEnvironment = await this.processRunner(
        uvPath,
        ['venv', paths.environmentDir, '--python', MANAGED_PYTHON_VERSION, '--managed-python', '--seed', '--clear'],
        { env: buildProvisioningEnv(paths), timeoutMs: INSTALL_TIMEOUT_MS }
      )
      if (createEnvironment.exitCode !== 0) {
        throw new Error(createEnvironment.stderr || `UV venv exited with code ${createEnvironment.exitCode}`)
      }
    }

    const packageRequirements = MANAGED_PYTHON_PACKAGES.map((entry) => entry.requirement)
    await this.runUvWithFallback(
      uvPath,
      ['pip', 'install', '--python', paths.executablePath, '--index-url', USTC_PYPI_INDEX, ...packageRequirements],
      paths,
      'Python package download',
      [{ name: 'USTC PyPI mirror' }]
    ).catch(async (mirrorError) => {
      logger.warn('USTC PyPI mirror failed, trying official PyPI', { error: mirrorError })
      await this.runUvWithFallback(
        uvPath,
        ['pip', 'install', '--python', paths.executablePath, ...packageRequirements],
        paths,
        'Python package download',
        [{ name: 'official PyPI' }, { name: 'official PyPI with system certificates', nativeTls: true }]
      )
    })

    const status = await this.getStatus()
    if (!status.ready) {
      throw new Error(status.message || `Managed Python preparation incomplete: ${status.missingPackages.join(', ')}`)
    }

    logger.info('Zen AI managed Python is ready', {
      version: status.version,
      executablePath: status.executablePath
    })
    return status
  }

  private async resolveUvPath(): Promise<string | null> {
    if (this.resolveUvPathOverride) return await this.resolveUvPathOverride()
    if (await isBinaryExists('uv')) return await getBinaryPath('uv')
    return await findExecutableInEnv('uv')
  }

  private runtimeFromStatus(status: ManagedPythonStatus): ManagedPythonRuntimeLocation {
    return {
      environmentDir: status.environmentPath,
      executablePath: status.executablePath,
      binDir: path.dirname(status.executablePath),
      source: status.source ?? 'managed'
    }
  }

  private async getPortableRuntime(paths: ManagedPythonPaths): Promise<ManagedPythonRuntimeLocation | Error | null> {
    if (!fs.existsSync(paths.portableManifestPath)) return null

    try {
      const manifest = validateManagedPythonRuntimeManifest(
        JSON.parse(await fsp.readFile(paths.portableManifestPath, 'utf8')),
        this.platform,
        this.arch
      )
      const executableRelativePath = path.posix.relative('runtime', manifest.executablePath)
      const executablePath = path.resolve(paths.portableDir, ...executableRelativePath.split('/'))
      if (!executablePath.startsWith(`${path.resolve(paths.portableDir)}${path.sep}`)) {
        throw new Error('Installed runtime executable path is unsafe')
      }
      return {
        environmentDir: paths.portableDir,
        executablePath,
        binDir: path.dirname(executablePath),
        source: 'portable'
      }
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  private invalidPortableStatus(paths: ManagedPythonPaths, error: Error): ManagedPythonStatus {
    return {
      installed: true,
      ready: false,
      executablePath: paths.portableDir,
      environmentPath: paths.portableDir,
      missingPackages: MANAGED_PYTHON_PACKAGES.map((entry) => entry.id),
      packageProfileVersion: MANAGED_PYTHON_PROFILE_VERSION,
      source: 'portable',
      message: error.message
    }
  }

  private async tryInstallOfficialRuntime(paths: ManagedPythonPaths): Promise<ManagedPythonStatus | null> {
    if (!this.officialRuntimeBaseUrl) return null

    const assetName = getManagedPythonRuntimeAssetName(this.platform, this.arch)
    const url = new URL(assetName, this.officialRuntimeBaseUrl).toString()
    const downloadDir = path.join(paths.rootDir, '.downloads')
    const downloadPath = path.join(downloadDir, `${randomUUID()}-${assetName}`)
    await fsp.mkdir(downloadDir, { recursive: true })

    try {
      logger.info('Downloading the official Zen AI Python runtime', { url })
      await this.runtimePackageDownloader(url, downloadPath)
      return await this.installRuntimePackage(downloadPath)
    } catch (error) {
      logger.warn('Official Zen AI Python runtime download failed; falling back to uv', { url, error })
      return null
    } finally {
      await fsp.rm(downloadPath, { force: true }).catch(() => undefined)
    }
  }

  private async installRuntimePackage(packagePath: string): Promise<ManagedPythonStatus> {
    const paths = this.getPaths()
    const operationId = randomUUID()
    const stagingDir = path.join(paths.rootDir, `.runtime-import-${operationId}`)
    const backupDir = `${paths.portableDir}.backup-${operationId}`
    let backupCreated = false
    let newRuntimeInstalled = false

    await fsp.mkdir(paths.rootDir, { recursive: true })
    try {
      const extracted = await extractManagedPythonRuntimePackage(packagePath, stagingDir, this.platform, this.arch)
      const stagedRuntime: ManagedPythonRuntimeLocation = {
        environmentDir: extracted.runtimeDir,
        executablePath: extracted.executablePath,
        binDir: path.dirname(extracted.executablePath),
        source: 'portable'
      }
      const stagedStatus = await this.probeRuntime(stagedRuntime)
      if (!stagedStatus.ready) {
        throw new Error(
          stagedStatus.message || `Runtime package is incomplete: ${stagedStatus.missingPackages.join(', ')}`
        )
      }

      await fsp.writeFile(
        path.join(extracted.runtimeDir, MANAGED_PYTHON_INSTALLED_MANIFEST),
        `${JSON.stringify(extracted.manifest satisfies ManagedPythonRuntimeManifest, null, 2)}\n`,
        'utf8'
      )
      await fsp.mkdir(path.dirname(paths.portableDir), { recursive: true })
      if (fs.existsSync(paths.portableDir)) {
        await fsp.rename(paths.portableDir, backupDir)
        backupCreated = true
      }

      try {
        await fsp.rename(extracted.runtimeDir, paths.portableDir)
        newRuntimeInstalled = true
      } catch (error) {
        if (backupCreated && !fs.existsSync(paths.portableDir)) {
          await fsp.rename(backupDir, paths.portableDir)
          backupCreated = false
        }
        throw error
      }

      const installed = await this.getStatus()
      if (!installed.ready) {
        await fsp.rm(paths.portableDir, { recursive: true, force: true })
        newRuntimeInstalled = false
        if (backupCreated) await fsp.rename(backupDir, paths.portableDir)
        backupCreated = false
        throw new Error(installed.message || 'Imported Python runtime failed its final check')
      }
      if (backupCreated) {
        await fsp.rm(backupDir, { recursive: true, force: true })
        backupCreated = false
      }
      logger.info('Imported Zen AI Python runtime', {
        version: installed.version,
        platform: this.platform,
        arch: this.arch
      })
      newRuntimeInstalled = false
      return installed
    } catch (error) {
      if (newRuntimeInstalled) {
        await fsp.rm(paths.portableDir, { recursive: true, force: true }).catch(() => undefined)
        newRuntimeInstalled = false
      }
      if (backupCreated && fs.existsSync(backupDir) && !fs.existsSync(paths.portableDir)) {
        await fsp.rename(backupDir, paths.portableDir).catch(() => undefined)
        backupCreated = false
      }
      throw error
    } finally {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      if (backupCreated && fs.existsSync(backupDir) && fs.existsSync(paths.portableDir)) {
        await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  private async runUvWithFallback(
    uvPath: string,
    args: string[],
    paths: ManagedPythonPaths,
    operation: string,
    attempts: Array<{ name: string; pythonInstallMirror?: string; nativeTls?: boolean }>
  ): Promise<void> {
    const errors: string[] = []
    for (const attempt of attempts) {
      try {
        const result = await this.processRunner(uvPath, args, {
          env: buildProvisioningEnv(paths, attempt),
          timeoutMs: INSTALL_TIMEOUT_MS
        })
        if (result.exitCode === 0) return
        const message = result.stderr || `${operation} exited with code ${result.exitCode}`
        errors.push(`${attempt.name}: ${message}`)
        logger.warn(`${operation} attempt failed`, { source: attempt.name, message })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`${attempt.name}: ${message}`)
        logger.warn(`${operation} attempt failed`, { source: attempt.name, message })
      }
    }

    const lastError = errors.at(-1) || 'unknown error'
    throw new Error(
      `${operation} failed after trying ${attempts.map((attempt) => attempt.name).join(', ')}. ` +
        `Use "Import offline package" if the network is restricted. Last error: ${lastError.slice(0, 600)}`
    )
  }
}

export const managedPythonService = new ManagedPythonService()
