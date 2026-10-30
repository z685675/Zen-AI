/** Personal quota errors are business refusals, not upstream/channel failures. */
export class ModelDailyQuotaRefusal extends Error {
  readonly statusCode: number
  readonly isRetryable = false
  constructor(
    readonly status: number,
    readonly responseBody: string
  ) {
    super('Model daily quota admission refused')
    this.statusCode = status
  }
  get body() {
    return this.responseBody
  }
}

/** Admission transport/protocol failure, not a model/channel failure. */
export class ModelDailyQuotaRequestError extends Error {
  readonly name = 'ModelDailyQuotaRequestError'
  readonly code = 'model_daily_quota_unavailable'
  readonly zenFailureStage = 'quota-admission'
  readonly isRetryable = true
  constructor(
    readonly zenRequestUrl: string,
    cause: unknown
  ) {
    super('Model daily quota admission request failed', { cause })
  }
}

export const MODEL_DAILY_TURN_MODE_HEADER = 'X-Zen-Model-Turn-Mode'
export const MODEL_DAILY_TURN_INLINE_MODE = 'inline-v1'
export const MODEL_DAILY_QUOTA_ERROR_HEADER = 'X-Zen-Model-Quota-Error'

export type ModelDailyTurnResult = {
  model: string
  date: string
  current_date: string
  limit: number
  used: number
  exhausted: boolean
  extra_allowed: boolean
  pending: boolean
}

export function parseModelDailyTurnResult(value: unknown): ModelDailyTurnResult | undefined {
  if (!value || typeof value !== 'object') return undefined
  const result = value as ModelDailyTurnResult
  if (
    typeof result.model !== 'string' ||
    !result.model ||
    result.model.length > 200 ||
    typeof result.date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(result.date) ||
    typeof result.current_date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(result.current_date) ||
    !Number.isSafeInteger(result.limit) ||
    result.limit < 0 ||
    !Number.isSafeInteger(result.used) ||
    result.used < 0 ||
    typeof result.exhausted !== 'boolean' ||
    typeof result.extra_allowed !== 'boolean' ||
    typeof result.pending !== 'boolean'
  )
    return undefined
  return {
    model: result.model,
    date: result.date,
    current_date: result.current_date,
    limit: result.limit,
    used: result.used,
    exhausted: result.exhausted,
    extra_allowed: result.extra_allowed,
    pending: result.pending
  }
}

export function readModelDailyQuotaResults(value: unknown): ModelDailyTurnResult[] {
  if (!Array.isArray(value) || value.length > 200) return []
  return value
    .map(parseModelDailyTurnResult)
    .filter((result): result is ModelDailyTurnResult => Boolean(result && shouldShowModelDailyQuotaNotice(result)))
}

export function shouldShowModelDailyQuotaNotice(result: ModelDailyTurnResult): boolean {
  return (
    result.date === result.current_date &&
    result.limit > 0 &&
    result.used >= result.limit &&
    result.exhausted &&
    !result.extra_allowed &&
    !result.pending
  )
}

/** In-memory task capability. Preparing it is entirely local: the API admits
 * it atomically with the FIRST formal model request. Never persist/log it.
 * API must be upgraded before the client; there is no preflight fallback.
 */
export class ModelDailyQuotaTurn {
  private permit?: string
  private authorization?: string
  private heartbeat?: ReturnType<typeof setInterval>
  private finishing?: Promise<ModelDailyTurnResult | undefined>
  private endpoint: URL

  constructor(
    baseURL: string,
    private readonly model: string
  ) {
    this.endpoint = new URL(baseURL)
    if (
      !['http:', 'https:'].includes(this.endpoint.protocol) ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash
    )
      throw new Error('Unsupported model daily quota address')
    this.endpoint.pathname =
      this.endpoint.pathname.replace(/\/(?:v1|v1beta)\/?$/, '').replace(/\/$/, '') + '/api/usage/token/model-daily/turn'
    this.endpoint.search = ''
    this.endpoint.hash = ''
  }

  get requestUrl(): string {
    return this.endpoint.href
  }

  async getPermit(headers: Headers, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted()
    if (!this.permit) {
      this.finishing = undefined
      const key = headers.get('x-api-key') || headers.get('x-goog-api-key')
      this.authorization = headers.get('authorization') || (key ? `Bearer ${key}` : undefined)
      if (!this.authorization) return undefined
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
      const permit = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      this.permit = permit
      const authorization = this.authorization
      this.heartbeat = setInterval(() => {
        void this.request({ model: this.model, permit, close: false }, authorization)
          .then((response) => response.body?.cancel())
          .catch(() => {})
      }, 60_000)
      this.heartbeat.unref?.()
    }
    return this.permit
  }

  private request(body: Record<string, unknown>, authorization: string, timeoutMs = 5000) {
    return fetch(`${this.endpoint.href}/state`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store'
    })
  }

  private async refusal(response: Response) {
    // Responses are bounded and never include provider credentials.
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (reader) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > 16_384) throw new Error('Model quota response exceeds limit')
        chunks.push(next.value)
      }
    } finally {
      await reader?.cancel().catch(() => {})
    }
    const decoder = new TextDecoder()
    const body = chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
    return new ModelDailyQuotaRefusal(response.status, body)
  }

  finish(): Promise<ModelDailyTurnResult | undefined> {
    if (this.finishing) return this.finishing
    const permit = this.permit
    const authorization = this.authorization
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.permit = undefined
    this.authorization = undefined
    this.finishing = (async () => {
      if (!permit || !authorization) return undefined
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const response = await this.request({ model: this.model, permit, close: true }, authorization, 1500)
          if (!response.ok) {
            await response.body?.cancel().catch(() => {})
            return undefined
          }
          const payload = JSON.parse((await this.refusal(response)).body) as { success?: unknown; data?: unknown }
          const result = payload.success === true ? parseModelDailyTurnResult(payload.data) : undefined
          if (!result || result.model !== this.model) return undefined
          if (!result.pending) return result
          // Response bytes can arrive just before the relay's final settlement.
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150))
        }
      } catch {
        /* Advisory/cleanup outages never invalidate a model result. */
      }
      return undefined
    })()
    return this.finishing
  }
}

/** One user task can use multiple models/keys, including checkpoint calls. */
export class ModelDailyQuotaTask {
  private readonly turns = new Map<string, ModelDailyQuotaTurn>()
  private finishing?: Promise<ModelDailyTurnResult[]>

  async headers(baseURL: string, model: string, key: string, signal: AbortSignal): Promise<Record<string, string>> {
    signal.throwIfAborted()
    if (this.finishing) throw new Error('Model quota task has already finished')
    if (!key) return {}
    const scope = JSON.stringify([baseURL, model, key])
    let turn = this.turns.get(scope)
    if (!turn) {
      turn = new ModelDailyQuotaTurn(baseURL, model)
      this.turns.set(scope, turn)
    }
    const permit = await turn.getPermit(new Headers({ Authorization: `Bearer ${key}` }), signal)
    return permit ? { 'X-Zen-Model-Turn': permit, [MODEL_DAILY_TURN_MODE_HEADER]: MODEL_DAILY_TURN_INLINE_MODE } : {}
  }

  finish(): Promise<ModelDailyTurnResult[]> {
    this.finishing ??= Promise.all([...this.turns.values()].map((turn) => turn.finish())).then((results) =>
      results.filter((result): result is ModelDailyTurnResult => result !== undefined)
    )
    return this.finishing
  }
}
