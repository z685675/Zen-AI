import { loggerService } from '@logger'
import {
  DEFAULT_MODEL_POLICY,
  isModelPolicy,
  type ModelPolicySnapshot,
  normalizeModelPolicy
} from '@shared/config/modelPolicy'
import { app, net } from 'electron'

import { ConfigKeys, configManager } from './ConfigManager'

const logger = loggerService.withContext('RemoteModelPolicyService')
const REFRESH_MIN_INTERVAL_MS = 15 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10 * 1000
const DEFAULT_ENDPOINT = 'https://zenai.925636.xyz/api/client/model-policy'

type RemoteModelPolicyResponse = {
  version?: number
  schemaVersion?: number
  updatedAt?: string
  etag?: string
  policy?: unknown
  data?: {
    policy?: unknown
    version?: number
    schemaVersion?: number
    updatedAt?: string
    etag?: string
  }
}

const getEndpoint = (): string => {
  return import.meta.env.MAIN_VITE_MODEL_POLICY_URL || DEFAULT_ENDPOINT
}

const createSnapshot = (
  policy: ModelPolicySnapshot['policy'],
  source: ModelPolicySnapshot['source'],
  previous?: ModelPolicySnapshot,
  metadata?: { etag?: string; fetchedAt?: string }
): ModelPolicySnapshot => {
  const now = metadata?.fetchedAt ?? new Date().toISOString()
  return {
    policy,
    version: policy.version,
    etag: metadata?.etag ?? previous?.etag,
    fetchedAt: now,
    appliedAt: previous?.appliedAt ?? now,
    source
  }
}

const getBuiltinSnapshot = (): ModelPolicySnapshot => createSnapshot(DEFAULT_MODEL_POLICY, 'builtin')

const isValidCachedSnapshot = (value: unknown): value is ModelPolicySnapshot => {
  if (typeof value !== 'object' || value === null) return false
  const snapshot = value as Partial<ModelPolicySnapshot>
  return (
    typeof snapshot.version === 'number' &&
    typeof snapshot.fetchedAt === 'string' &&
    typeof snapshot.appliedAt === 'string' &&
    (snapshot.source === 'remote' || snapshot.source === 'cache' || snapshot.source === 'builtin') &&
    isModelPolicy(snapshot.policy)
  )
}

class RemoteModelPolicyService {
  private refreshPromise: Promise<ModelPolicySnapshot> | null = null

  getSnapshot(): ModelPolicySnapshot {
    const cached = configManager.get<unknown>(ConfigKeys.RemoteModelPolicyCache)
    return isValidCachedSnapshot(cached) ? cached : getBuiltinSnapshot()
  }

  async refresh(force = false): Promise<ModelPolicySnapshot> {
    if (this.refreshPromise) return this.refreshPromise

    const current = this.getSnapshot()
    const fetchedAt = Date.parse(current.fetchedAt)
    if (
      !force &&
      current.source !== 'builtin' &&
      Number.isFinite(fetchedAt) &&
      Date.now() - fetchedAt < REFRESH_MIN_INTERVAL_MS
    ) {
      return current
    }

    this.refreshPromise = this.fetchAndApply(current).finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  private async fetchAndApply(current: ModelPolicySnapshot): Promise<ModelPolicySnapshot> {
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Zen-AI-Version': app.getVersion(),
        'X-Zen-AI-Platform': process.platform
      }
      if (current.etag) headers['If-None-Match'] = current.etag

      const response = await net.fetch(getEndpoint(), {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })

      if (response.status === 304) {
        const refreshed = { ...current, fetchedAt: new Date().toISOString() }
        configManager.set(ConfigKeys.RemoteModelPolicyCache, refreshed)
        return refreshed
      }

      if (!response.ok) throw new Error(`model policy request failed: ${response.status}`)

      const payload = (await response.json()) as RemoteModelPolicyResponse
      const data = payload.data ?? payload
      const policy = data.policy ?? payload.policy ?? data
      if (!isModelPolicy(policy)) throw new Error('model policy response failed validation')
      if (policy.version < current.version) throw new Error(`model policy version regressed: ${policy.version}`)

      const next = createSnapshot(normalizeModelPolicy(policy), 'remote', current, {
        etag: response.headers.get('etag') ?? data.etag ?? payload.etag ?? undefined
      })
      configManager.set(ConfigKeys.RemoteModelPolicyCache, next)
      return next
    } catch (error) {
      logger.warn('Failed to refresh remote model policy; using cached policy', error as Error)
      if (current.source === 'remote') {
        const cached = { ...current, source: 'cache' as const }
        configManager.set(ConfigKeys.RemoteModelPolicyCache, cached)
        return cached
      }
      return current
    }
  }
}

export const remoteModelPolicyService = new RemoteModelPolicyService()
