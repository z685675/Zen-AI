import { loggerService } from '@logger'
import { isWin } from '@renderer/config/constant'

const logger = loggerService.withContext('RendererAssistantEnvironmentService')

export type DependencyId = 'bun' | 'uv' | 'uvx' | 'git' | 'pyodide'

export interface DependencyStatus {
  id: DependencyId
  installed: boolean
  source: 'app' | 'system' | 'network' | 'missing' | 'error'
  path?: string
  message?: string
}

export interface AssistantEnvironmentCheckResult {
  bun: DependencyStatus
  uv: DependencyStatus
  uvx: DependencyStatus
  git: DependencyStatus
  pyodide: DependencyStatus
  binariesDir: string
  checkedAt: number
}

export const REQUIRED_ASSISTANT_DEPENDENCIES: DependencyId[] = isWin
  ? ['bun', 'uv', 'uvx', 'git']
  : ['bun', 'uv', 'uvx']

const ASSISTANT_ENVIRONMENT_CACHE_TTL_MS = 5 * 60 * 1000

let cachedEnvironmentResult: AssistantEnvironmentCheckResult | null = null
let cachedEnvironmentError: string | null = null
let cachedEnvironmentCheckedAt = 0
let checkPromise: Promise<AssistantEnvironmentCheckResult> | null = null
let repairPromise: Promise<AssistantEnvironmentCheckResult> | null = null
let startupPreflightStarted = false

export const getFreshAssistantEnvironmentCache = () => {
  if (!cachedEnvironmentCheckedAt || Date.now() - cachedEnvironmentCheckedAt > ASSISTANT_ENVIRONMENT_CACHE_TTL_MS) {
    return null
  }

  return {
    error: cachedEnvironmentError,
    result: cachedEnvironmentResult
  }
}

const setEnvironmentCache = (result: AssistantEnvironmentCheckResult | null, error: string | null) => {
  cachedEnvironmentResult = result
  cachedEnvironmentError = error
  cachedEnvironmentCheckedAt = Date.now()
}

export const checkAssistantEnvironmentWithCache = async (options?: {
  force?: boolean
}): Promise<AssistantEnvironmentCheckResult> => {
  const freshCache = options?.force ? null : getFreshAssistantEnvironmentCache()
  if (freshCache?.result && !freshCache.error) {
    return freshCache.result
  }

  if (checkPromise) {
    return checkPromise
  }

  checkPromise = window.api
    .checkAssistantEnvironment()
    .then((result) => {
      setEnvironmentCache(result, null)
      return result
    })
    .catch((error: any) => {
      const message = error?.message || String(error)
      setEnvironmentCache(null, message)
      throw error
    })
    .finally(() => {
      checkPromise = null
    })

  return checkPromise
}

const hasMissingRequiredDependencies = (result: AssistantEnvironmentCheckResult) =>
  REQUIRED_ASSISTANT_DEPENDENCIES.some((id) => !result[id].installed)

export const repairRequiredAssistantEnvironment = async (options?: {
  installGit?: boolean
}): Promise<AssistantEnvironmentCheckResult> => {
  if (repairPromise) {
    return repairPromise
  }

  repairPromise = (async () => {
    const initialResult = await checkAssistantEnvironmentWithCache({ force: true })
    if (!hasMissingRequiredDependencies(initialResult)) {
      return initialResult
    }

    if (!initialResult.bun.installed) {
      try {
        await window.api.installBunBinary()
      } catch (error) {
        logger.warn('Failed to auto install Bun', { error })
      }
    }

    if (!initialResult.uv.installed || !initialResult.uvx.installed) {
      try {
        await window.api.installUVBinary()
      } catch (error) {
        logger.warn('Failed to auto install UV', { error })
      }
    }

    if (options?.installGit && isWin && !initialResult.git.installed) {
      try {
        await window.api.installGitForWindows()
      } catch (error) {
        logger.warn('Failed to auto install Git for Windows', { error })
      }
    }

    return checkAssistantEnvironmentWithCache({ force: true })
  })().finally(() => {
    repairPromise = null
  })

  return repairPromise
}

export const runStartupAssistantEnvironmentPreflight = async (): Promise<void> => {
  if (startupPreflightStarted) {
    return
  }

  startupPreflightStarted = true

  try {
    await repairRequiredAssistantEnvironment({ installGit: false })
  } catch (error) {
    logger.warn('Startup assistant environment preflight failed', { error })
  }
}
