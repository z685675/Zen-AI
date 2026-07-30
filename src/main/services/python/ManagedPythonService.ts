import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { getProxyEnvironment } from '@main/services/proxy/nodeProxy'
import { findExecutableInEnv, getBinaryPath, isBinaryExists } from '@main/utils/process'
import { app } from 'electron'

const logger = loggerService.withContext('ManagedPythonService')

export const MANAGED_PYTHON_VERSION = '3.12'
export const MANAGED_PYTHON_PROFILE_VERSION = '1'

export const MANAGED_PYTHON_PACKAGES = [
  { id: 'numpy', requirement: 'numpy>=2.1,<3', importName: 'numpy' },
  { id: 'pandas', requirement: 'pandas>=2.2,<3', importName: 'pandas' },
  { id: 'openpyxl', requirement: 'openpyxl>=3.1,<4', importName: 'openpyxl' },
  { id: 'xlsxwriter', requirement: 'xlsxwriter>=3.2,<4', importName: 'xlsxwriter' },
  { id: 'matplotlib', requirement: 'matplotlib>=3.9,<4', importName: 'matplotlib' },
  { id: 'pillow', requirement: 'pillow>=11,<13', importName: 'PIL' },
  { id: 'pypdf', requirement: 'pypdf>=5,<7', importName: 'pypdf' },
  { id: 'pymupdf', requirement: 'pymupdf>=1.24,<2', importName: 'pymupdf' },
  { id: 'python-docx', requirement: 'python-docx>=1.1,<2', importName: 'docx' },
  { id: 'python-pptx', requirement: 'python-pptx>=1.0,<2', importName: 'pptx' }
] as const

export type ManagedPythonPackageId = (typeof MANAGED_PYTHON_PACKAGES)[number]['id']

export interface ManagedPythonPaths {
  rootDir: string
  installationsDir: string
  cacheDir: string
  environmentDir: string
  executablePath: string
  binDir: string
}

export interface ManagedPythonStatus {
  installed: boolean
  ready: boolean
  version?: string
  executablePath: string
  environmentPath: string
  missingPackages: ManagedPythonPackageId[]
  packageProfileVersion: string
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
  resolveUvPath?: () => Promise<string | null>
  processRunner?: ProcessRunner
}

const INSTALL_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_EXECUTION_TIMEOUT_MS = 2 * 60 * 1000
const MAX_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024

export function getManagedPythonPaths(
  rootDir: string,
  platform: NodeJS.Platform = process.platform
): ManagedPythonPaths {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const environmentDir = pathApi.join(rootDir, 'envs', `productivity-${MANAGED_PYTHON_PROFILE_VERSION}`)
  const binDir = platform === 'win32' ? pathApi.join(environmentDir, 'Scripts') : pathApi.join(environmentDir, 'bin')
  const executablePath = pathApi.join(binDir, platform === 'win32' ? 'python.exe' : 'python')

  return {
    rootDir,
    installationsDir: pathApi.join(rootDir, 'installations'),
    cacheDir: pathApi.join(rootDir, 'cache'),
    environmentDir,
    executablePath,
    binDir
  }
}

function buildSanitizedExecutionEnv(
  paths: ManagedPythonPaths,
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
  env[pathKey] = [paths.binDir, env[pathKey]].filter(Boolean).join(path.delimiter)
  env.VIRTUAL_ENV = paths.environmentDir
  env.PYTHONNOUSERSITE = '1'
  env.PYTHONDONTWRITEBYTECODE = '1'
  env.PYTHONUTF8 = '1'
  env.ZEN_PYTHON_EXECUTABLE = paths.executablePath
  env.ZEN_PYTHON_HOME = paths.rootDir

  return env
}

function buildProvisioningEnv(paths: ManagedPythonPaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...getProxyEnvironment(process.env),
    UV_CACHE_DIR: paths.cacheDir,
    UV_MANAGED_PYTHON: '1',
    UV_NATIVE_TLS: '1',
    UV_NO_PROGRESS: '1',
    UV_PYTHON_DOWNLOADS: 'automatic',
    UV_PYTHON_INSTALL_DIR: paths.installationsDir
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
  private readonly resolveUvPathOverride?: () => Promise<string | null>
  private readonly processRunner: ProcessRunner
  private preparePromise: Promise<ManagedPythonStatus> | null = null

  constructor(options: ManagedPythonServiceOptions = {}) {
    this.rootDirOverride = options.rootDir
    this.platform = options.platform ?? process.platform
    this.resolveUvPathOverride = options.resolveUvPath
    this.processRunner = options.processRunner ?? runProcess
  }

  getPaths(): ManagedPythonPaths {
    const rootDir = this.rootDirOverride ?? path.join(app.getPath('userData'), 'runtimes', 'python')
    return getManagedPythonPaths(rootDir, this.platform)
  }

  async getStatus(): Promise<ManagedPythonStatus> {
    const paths = this.getPaths()
    if (!fs.existsSync(paths.executablePath)) {
      return {
        installed: false,
        ready: false,
        executablePath: paths.executablePath,
        environmentPath: paths.environmentDir,
        missingPackages: MANAGED_PYTHON_PACKAGES.map((entry) => entry.id),
        packageProfileVersion: MANAGED_PYTHON_PROFILE_VERSION
      }
    }

    const probe = [
      'import importlib.util, json, sys',
      `packages = ${JSON.stringify(MANAGED_PYTHON_PACKAGES.map(({ id, importName }) => ({ id, importName })))}`,
      "missing = [p['id'] for p in packages if importlib.util.find_spec(p['importName']) is None]",
      "print(json.dumps({'version': '.'.join(map(str, sys.version_info[:3])), 'missing': missing}))"
    ].join('; ')

    try {
      const result = await this.processRunner(paths.executablePath, ['-I', '-X', 'utf8', '-c', probe], {
        env: buildSanitizedExecutionEnv(paths),
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
        executablePath: paths.executablePath,
        environmentPath: paths.environmentDir,
        missingPackages,
        packageProfileVersion: MANAGED_PYTHON_PROFILE_VERSION
      }
    } catch (error) {
      return {
        installed: true,
        ready: false,
        executablePath: paths.executablePath,
        environmentPath: paths.environmentDir,
        missingPackages: MANAGED_PYTHON_PACKAGES.map((entry) => entry.id),
        packageProfileVersion: MANAGED_PYTHON_PROFILE_VERSION,
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
    const cwd = options?.cwd ? path.resolve(options.cwd) : paths.rootDir
    const stat = await fsp.stat(cwd).catch(() => null)
    if (!stat?.isDirectory()) throw new Error(`Python working directory does not exist: ${cwd}`)

    const startedAt = Date.now()
    const result = await this.processRunner(paths.executablePath, pythonArgs, {
      cwd,
      env: buildSanitizedExecutionEnv(paths),
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

    const env = buildSanitizedExecutionEnv(this.getPaths(), sourceEnv)
    return Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
  }

  private async prepare(): Promise<ManagedPythonStatus> {
    const existing = await this.getStatus()
    if (existing.ready) return existing

    const paths = this.getPaths()
    const uvPath = await this.resolveUvPath()
    if (!uvPath) throw new Error('UV is required before Zen AI managed Python can be prepared')

    await Promise.all([
      fsp.mkdir(paths.installationsDir, { recursive: true }),
      fsp.mkdir(paths.cacheDir, { recursive: true }),
      fsp.mkdir(path.dirname(paths.environmentDir), { recursive: true })
    ])

    const env = buildProvisioningEnv(paths)
    logger.info('Preparing Zen AI managed Python', {
      version: MANAGED_PYTHON_VERSION,
      environmentPath: paths.environmentDir,
      packageCount: MANAGED_PYTHON_PACKAGES.length
    })

    const installPython = await this.processRunner(
      uvPath,
      [
        'python',
        'install',
        MANAGED_PYTHON_VERSION,
        '--install-dir',
        paths.installationsDir,
        '--no-bin',
        '--no-registry',
        '--managed-python'
      ],
      { env, timeoutMs: INSTALL_TIMEOUT_MS }
    )
    if (installPython.exitCode !== 0) {
      throw new Error(installPython.stderr || `UV Python install exited with code ${installPython.exitCode}`)
    }

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
        { env, timeoutMs: INSTALL_TIMEOUT_MS }
      )
      if (createEnvironment.exitCode !== 0) {
        throw new Error(createEnvironment.stderr || `UV venv exited with code ${createEnvironment.exitCode}`)
      }
    }

    const installPackages = await this.processRunner(
      uvPath,
      [
        'pip',
        'install',
        '--python',
        paths.executablePath,
        ...MANAGED_PYTHON_PACKAGES.map((entry) => entry.requirement)
      ],
      { env, timeoutMs: INSTALL_TIMEOUT_MS }
    )
    if (installPackages.exitCode !== 0) {
      throw new Error(installPackages.stderr || `UV package install exited with code ${installPackages.exitCode}`)
    }

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
}

export const managedPythonService = new ManagedPythonService()
