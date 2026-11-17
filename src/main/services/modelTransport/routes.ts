import {
  CLIENT_CONNECTION_HEALTH,
  CLIENT_CONNECTION_ORIGIN,
  CLIENT_CONNECTION_PATH,
  type ClientConnectionPolicy,
  isClientConnectionPolicy,
  isRoutableApiRequest
} from '@shared/clientConnections'

import type { ConnectionRecord } from './connection'

const REFRESH_MS = 60_000
const PROBE_MS = 30_000
const COOLDOWN_MS = 120_000
const HEALTH_VALID_MS = 60_000

type RouteMetadata = { route: 'ip-direct' | 'cloudflare'; connectionOrigin: string; policyVersion?: number }
const responseRoutes = new WeakMap<Response, RouteMetadata>()
export const clientResponseRoute = (response: Response) => responseRoutes.get(response)

interface Dependencies {
  fetch: typeof fetch
  load: () => unknown
  save: (policy: ClientConnectionPolicy) => void
  now?: () => number
}

/** Selection happens before submission. This class never replays an HTTP request. */
export class ClientConnectionRouter {
  private policy?: ClientConnectionPolicy
  private refreshPending?: Promise<void>
  private probePending?: Promise<boolean>
  private lastRefresh = -Infinity
  private lastProbe = -Infinity
  private healthyUntil = 0
  private failedUntil = 0
  private recovery = false
  private successes = 0
  private now: () => number

  constructor(private deps: Dependencies) {
    this.now = deps.now ?? Date.now
    const cached = deps.load()
    if (isClientConnectionPolicy(cached)) this.policy = cached
  }

  async refresh(): Promise<void> {
    if (this.refreshPending) return this.refreshPending
    if (this.now() - this.lastRefresh < REFRESH_MS) return
    this.lastRefresh = this.now()
    this.refreshPending = (async () => {
      // Only the original HTTPS domain can authorize credential routing.
      // A previous IP is a data path, never a policy authority.
      try {
        const response = await this.deps.fetch(CLIENT_CONNECTION_ORIGIN + CLIENT_CONNECTION_PATH, {
          signal: AbortSignal.timeout(3500),
          redirect: 'error',
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          cache: 'no-store'
        })
        if (!response.ok) {
          await response.body?.cancel()
          return
        }
        const payload = await this.readJSON(response)
        const next = (payload as { data?: unknown }).data
        if (!isClientConnectionPolicy(next) || (this.policy && next.version < this.policy.version)) return
        if (this.policy && next.version === this.policy.version) return
        if (
          next.directOrigin !== this.policy?.directOrigin ||
          next.mode !== this.policy?.mode ||
          next.deploymentId !== this.policy?.deploymentId
        ) {
          this.healthyUntil = 0
          this.failedUntil = 0
          this.lastProbe = -Infinity
          this.recovery = false
          this.successes = 0
        }
        this.deps.save(next)
        this.policy = next
        return
      } catch {
        /* Keep the last policy authorized by the original HTTPS domain. */
      }
    })().finally(() => {
      this.refreshPending = undefined
    })
    return this.refreshPending
  }

  private async readJSON(response: Response): Promise<unknown> {
    if (!response.body) throw new Error('Empty connection metadata')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) return JSON.parse(text + decoder.decode())
        bytes += item.value.byteLength
        if (bytes > 8192) throw new Error('Connection metadata is too large')
        text += decoder.decode(item.value, { stream: true })
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  private async probe(): Promise<boolean> {
    if (this.probePending) return this.probePending
    if (this.now() < this.failedUntil || this.now() - this.lastProbe < PROBE_MS) return false
    const policy = this.policy!
    this.lastProbe = this.now()
    this.probePending = (async () => {
      try {
        const response = await this.deps.fetch(policy.directOrigin + CLIENT_CONNECTION_HEALTH, {
          signal: AbortSignal.timeout(2000),
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store'
        })
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error('Health check failed')
        }
        const health = (await this.readJSON(response)) as { schemaVersion?: number; deploymentId?: string }
        if (health.schemaVersion !== 1 || health.deploymentId !== policy.deploymentId)
          throw new Error('Service identity mismatch')
        if (policy !== this.policy) return false
        this.successes++
        if (this.recovery && this.successes < 2) return false
        this.recovery = false
        this.healthyUntil = this.now() + HEALTH_VALID_MS
        return true
      } catch {
        if (policy === this.policy) this.fail(policy)
        return false
      }
    })().finally(() => {
      this.probePending = undefined
    })
    return this.probePending
  }

  private fail(policy: ClientConnectionPolicy) {
    if (this.policy !== policy) return
    this.healthyUntil = 0
    this.failedUntil = this.now() + COOLDOWN_MS
    this.recovery = true
    this.successes = 0
  }

  async fetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    send: typeof fetch,
    record: ConnectionRecord = () => {}
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : undefined
    if (!url || !isRoutableApiRequest(url, init?.method)) return send(input, init)
    init?.signal?.throwIfAborted()
    if (!this.policy) await this.refresh()
    else void this.refresh()
    let policy = this.policy
    let direct = false
    if (policy?.mode === 'auto') direct = this.now() < this.healthyUntil || (await this.probe())
    // Configuration may change while a probe is pending.
    if (policy !== this.policy || this.policy?.mode !== 'auto') direct = false
    policy = this.policy
    init?.signal?.throwIfAborted()
    const target = new URL(url)
    if (direct && policy) target.host = new URL(policy.directOrigin).host
    try {
      record('connection-route', {
        route: direct ? 'ip-direct' : 'cloudflare',
        origin: target.origin,
        policyVersion: policy?.version
      })
    } catch {
      /* diagnostics only */
    }
    const options = { ...init, redirect: 'error' as const, credentials: 'omit' as const }
    const signal = init?.signal
    const failed = () => {
      if (direct && policy && (!signal?.aborted || signal.reason?.name === 'TimeoutError')) this.fail(policy)
    }
    const cleanup = () => signal?.removeEventListener('abort', aborted)
    const aborted = () => {
      if (signal?.reason?.name === 'TimeoutError') failed()
      cleanup()
    }
    if (direct) signal?.addEventListener('abort', aborted, { once: true })
    const tag = (response: Response) => {
      responseRoutes.set(response, {
        route: direct ? 'ip-direct' : 'cloudflare',
        connectionOrigin: target.origin,
        policyVersion: policy?.version
      })
      return response
    }
    try {
      const response = await send(target.href, options)
      if (direct && policy && [502, 503, 504].includes(response.status) && !response.headers.has('x-oneapi-request-id'))
        this.fail(policy)
      if (!direct || !policy || !response.body) {
        cleanup()
        return tag(response)
      }
      const reader = response.body.getReader()
      const body = new ReadableStream<Uint8Array>(
        {
          pull: async (controller) => {
            try {
              const item = await reader.read()
              if (item.done) {
                cleanup()
                controller.close()
              } else controller.enqueue(item.value)
            } catch (error) {
              failed()
              cleanup()
              controller.error(error)
            }
          },
          cancel: (reason) => {
            cleanup()
            return reader.cancel(reason)
          }
        },
        { highWaterMark: 0 }
      )
      return tag(
        new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      )
    } catch (error) {
      failed()
      cleanup()
      throw error
    }
  }
}
