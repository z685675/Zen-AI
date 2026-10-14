import { loggerService } from '@logger'

const logger = loggerService.withContext('RendererAssistantEnvironmentService')

export type DependencyId = 'bun' | 'uv' | 'uvx' | 'python' | 'pyodide'
export type DependencySource = 'app' | 'system' | 'network' | 'missing' | 'error'

export const ASSISTANT_DEPENDENCY_I18N_KEYS = {
  bun: {
    name: 'settings.assistantEnvironment.dependencies.bun.name',
    description: 'settings.assistantEnvironment.dependencies.bun.description'
  },
  uv: {
    name: 'settings.assistantEnvironment.dependencies.uv.name',
    description: 'settings.assistantEnvironment.dependencies.uv.description'
  },
  uvx: {
    name: 'settings.assistantEnvironment.dependencies.uvx.name',
    description: 'settings.assistantEnvironment.dependencies.uvx.description'
  },
  python: {
    name: 'settings.assistantEnvironment.dependencies.python.name',
    description: 'settings.assistantEnvironment.dependencies.python.description'
  },
  pyodide: {
    name: 'settings.assistantEnvironment.dependencies.pyodide.name',
    description: 'settings.assistantEnvironment.dependencies.pyodide.description'
  }
} as const satisfies Record<DependencyId, { name: string; description: string }>

export const ASSISTANT_DEPENDENCY_SOURCE_I18N_KEYS = {
  app: 'settings.assistantEnvironment.sources.app',
  system: 'settings.assistantEnvironment.sources.system',
  network: 'settings.assistantEnvironment.sources.network',
  missing: 'settings.assistantEnvironment.status.missing',
  error: 'settings.assistantEnvironment.status.error'
} as const satisfies Record<DependencySource, string>

export interface DependencyStatus {
  id: DependencyId
  installed: boolean
  source: DependencySource
  path?: string
  message?: string
}

export interface AssistantEnvironmentCheckResult {
  bun: DependencyStatus
  uv: DependencyStatus
  uvx: DependencyStatus
  python: DependencyStatus
  pyodide: DependencyStatus
  binariesDir: string
  checkedAt: number
}

// Prepared automatically; not admission requirements for ordinary tasks.
export const AUTO_PREPARED_ASSISTANT_DEPENDENCIES: DependencyId[] = ['bun', 'uv', 'uvx', 'python']

const ASSISTANT_ENVIRONMENT_CACHE_TTL_MS = 5 * 60 * 1000

let cachedEnvironmentResult: AssistantEnvironmentCheckResult | null = null
let cachedEnvironmentError: string | null = null
let cachedEnvironmentCheckedAt = 0
let checkPromise: Promise<AssistantEnvironmentCheckResult> | null = null
let repairPromise: Promise<AssistantEnvironmentCheckResult> | null = null
let startupPreflightStarted = false
let preparing = false
const STARTUP_RETRY_DELAYS_MS = [60_000, 5 * 60_000]
export interface AssistantEnvironmentState {
  result: AssistantEnvironmentCheckResult | null
  error: string | null
  preparing: boolean
}
const environmentListeners = new Set<(state: AssistantEnvironmentState) => void>()

export const subscribeAssistantEnvironment = (listener: (state: AssistantEnvironmentState) => void) => {
  environmentListeners.add(listener)
  return () => {
    environmentListeners.delete(listener)
  }
}

export const getAssistantEnvironmentState = (): AssistantEnvironmentState => ({
  result: cachedEnvironmentResult,
  error: cachedEnvironmentError,
  preparing
})

const notifyEnvironmentListeners = () => {
  for (const listener of environmentListeners) listener(getAssistantEnvironmentState())
}

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
  notifyEnvironmentListeners()
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

const hasMissingPreparedDependencies = (result: AssistantEnvironmentCheckResult) =>
  AUTO_PREPARED_ASSISTANT_DEPENDENCIES.some((id) => !result[id].installed)

export const repairRequiredAssistantEnvironment = async (): Promise<AssistantEnvironmentCheckResult> => {
  if (repairPromise) {
    return repairPromise
  }

  preparing = true
  notifyEnvironmentListeners()
  repairPromise = (async () => {
    const initialResult = await checkAssistantEnvironmentWithCache({ force: true })
    if (!hasMissingPreparedDependencies(initialResult)) {
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

    if (!initialResult.python.installed) {
      try {
        await window.api.installManagedPython()
      } catch (error) {
        logger.warn('Failed to prepare Zen AI managed Python', { error })
      }
    }

    return checkAssistantEnvironmentWithCache({ force: true })
  })().finally(() => {
    repairPromise = null
    preparing = false
    notifyEnvironmentListeners()
  })

  return repairPromise
}

export const runStartupAssistantEnvironmentPreflight = async (): Promise<void> => {
  if (startupPreflightStarted) {
    return
  }

  startupPreflightStarted = true

  // Bounded retries for temporary first-start failures. The task pipeline
  // does not await this promise or any retry timer.
  const attempt = async (retryIndex: number) => {
    let retry = false
    try {
      const result = await repairRequiredAssistantEnvironment()
      retry = hasMissingPreparedDependencies(result)
    } catch (error) {
      logger.warn('Startup assistant environment preflight failed', { error })
      retry = true
    }
    if (retry && retryIndex < STARTUP_RETRY_DELAYS_MS.length) {
      setTimeout(() => void attempt(retryIndex + 1), STARTUP_RETRY_DELAYS_MS[retryIndex])
    }
  }
  await attempt(0)
}
