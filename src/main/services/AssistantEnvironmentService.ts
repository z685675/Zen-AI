import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import { autoDiscoverGitBash, findExecutableInEnv, getBinaryPath, isBinaryExists } from '@main/utils/process'
import { spawn } from 'child_process'

import { managedPythonService } from './python/ManagedPythonService'

const logger = loggerService.withContext('AssistantEnvironmentService')

export type AssistantEnvironmentDependencyId = 'bun' | 'uv' | 'uvx' | 'git' | 'python' | 'pyodide'

export type AssistantEnvironmentDependencySource = 'app' | 'system' | 'network' | 'missing' | 'error'

export interface AssistantEnvironmentDependencyStatus {
  id: AssistantEnvironmentDependencyId
  installed: boolean
  source: AssistantEnvironmentDependencySource
  path?: string
  message?: string
}

export interface AssistantEnvironmentCheckResult {
  bun: AssistantEnvironmentDependencyStatus
  uv: AssistantEnvironmentDependencyStatus
  uvx: AssistantEnvironmentDependencyStatus
  git: AssistantEnvironmentDependencyStatus
  python: AssistantEnvironmentDependencyStatus
  pyodide: AssistantEnvironmentDependencyStatus
  binariesDir: string
  checkedAt: number
}

const PYODIDE_BOOTSTRAP_URL = 'https://cdn.jsdelivr.net/pyodide/v0.28.0/full/pyodide.mjs'
const NETWORK_CHECK_TIMEOUT_MS = 7000
const WINGET_INSTALL_TIMEOUT_MS = 10 * 60 * 1000

async function checkBinary(id: 'bun' | 'uv' | 'uvx' | 'git'): Promise<AssistantEnvironmentDependencyStatus> {
  try {
    if (id === 'git' && isWin) {
      const gitBashPath = autoDiscoverGitBash()
      return gitBashPath
        ? { id, installed: true, source: 'system', path: gitBashPath }
        : { id, installed: false, source: 'missing' }
    }

    const systemPath = await findExecutableInEnv(id)
    if (systemPath) {
      return { id, installed: true, source: 'system', path: systemPath }
    }

    const appInstalled = await isBinaryExists(id)
    if (appInstalled) {
      return { id, installed: true, source: 'app', path: await getBinaryPath(id) }
    }

    return { id, installed: false, source: 'missing' }
  } catch (error) {
    logger.warn(`Failed to check ${id}`, { error })
    return {
      id,
      installed: false,
      source: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export function installGitForWindows(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!isWin) {
      reject(new Error('Git auto install is only supported on Windows'))
      return
    }

    const args = [
      'install',
      '--id',
      'Git.Git',
      '-e',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements'
    ]
    const child = spawn('winget', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Git installation timed out'))
    }, WINGET_INSTALL_TIMEOUT_MS)

    let stderr = ''

    child.stdout.on('data', (data) => {
      logger.debug(`winget Git install output: ${data}`)
    })

    child.stderr.on('data', (data) => {
      stderr += String(data)
      logger.warn(`winget Git install error output: ${data}`)
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        const gitBashPath = autoDiscoverGitBash()
        if (gitBashPath) {
          logger.info('Git for Windows installed successfully via winget', { gitBashPath })
          resolve()
          return
        }

        reject(
          new Error('Git was installed, but Git Bash was not detected. Please restart the app or install Git manually.')
        )
      }

      reject(new Error(stderr.trim() || `winget exited with code ${code}`))
    })
  })
}

async function checkPyodideNetwork(): Promise<AssistantEnvironmentDependencyStatus> {
  const checkUrl = async (method: 'HEAD' | 'GET') => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), NETWORK_CHECK_TIMEOUT_MS)

    try {
      const response = await fetch(PYODIDE_BOOTSTRAP_URL, {
        method,
        signal: controller.signal
      })
      return response.ok
    } finally {
      clearTimeout(timeout)
    }
  }

  try {
    let reachable = false

    try {
      reachable = await checkUrl('HEAD')
    } catch {
      reachable = false
    }

    if (!reachable) {
      reachable = await checkUrl('GET')
    }

    return reachable
      ? { id: 'pyodide', installed: true, source: 'network', path: PYODIDE_BOOTSTRAP_URL }
      : { id: 'pyodide', installed: false, source: 'missing' }
  } catch (error) {
    logger.warn('Failed to check Pyodide network availability', { error })
    return {
      id: 'pyodide',
      installed: false,
      source: 'error',
      path: PYODIDE_BOOTSTRAP_URL,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

async function checkManagedPython(): Promise<AssistantEnvironmentDependencyStatus> {
  try {
    const status = await managedPythonService.getStatus()
    return {
      id: 'python',
      installed: status.ready,
      source: status.installed ? 'app' : 'missing',
      path: status.executablePath,
      message:
        status.message ||
        (status.missingPackages.length > 0
          ? `Missing managed packages: ${status.missingPackages.join(', ')}`
          : undefined)
    }
  } catch (error) {
    logger.warn('Failed to check managed Python', { error })
    return {
      id: 'python',
      installed: false,
      source: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function installManagedPython(): Promise<void> {
  await managedPythonService.ensureReady()
}

export async function checkAssistantEnvironment(): Promise<AssistantEnvironmentCheckResult> {
  const [bun, uv, uvx, git, python, pyodide] = await Promise.all([
    checkBinary('bun'),
    checkBinary('uv'),
    checkBinary('uvx'),
    checkBinary('git'),
    checkManagedPython(),
    checkPyodideNetwork()
  ])

  return {
    bun,
    uv,
    uvx,
    git,
    python,
    pyodide,
    binariesDir: await getBinaryPath(),
    checkedAt: Date.now()
  }
}
