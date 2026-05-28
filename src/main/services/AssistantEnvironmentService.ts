import { loggerService } from '@logger'
import { findExecutableInEnv, getBinaryPath, isBinaryExists } from '@main/utils/process'

const logger = loggerService.withContext('AssistantEnvironmentService')

export type AssistantEnvironmentDependencyId = 'bun' | 'uv' | 'uvx' | 'git' | 'pyodide'

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
  pyodide: AssistantEnvironmentDependencyStatus
  binariesDir: string
  checkedAt: number
}

const PYODIDE_BOOTSTRAP_URL = 'https://cdn.jsdelivr.net/pyodide/v0.28.0/full/pyodide.mjs'
const NETWORK_CHECK_TIMEOUT_MS = 7000

async function checkBinary(id: 'bun' | 'uv' | 'uvx' | 'git'): Promise<AssistantEnvironmentDependencyStatus> {
  try {
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

export async function checkAssistantEnvironment(): Promise<AssistantEnvironmentCheckResult> {
  const [bun, uv, uvx, git, pyodide] = await Promise.all([
    checkBinary('bun'),
    checkBinary('uv'),
    checkBinary('uvx'),
    checkBinary('git'),
    checkPyodideNetwork()
  ])

  return {
    bun,
    uv,
    uvx,
    git,
    pyodide,
    binariesDir: await getBinaryPath(),
    checkedAt: Date.now()
  }
}
