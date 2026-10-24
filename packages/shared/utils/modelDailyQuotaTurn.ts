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

/** An in-memory per-question capability, never persisted in native config or
 * diagnostics. All model calls/compaction in that question share this permit.
 * The server remains authoritative; an old server only falls back on 404/405.
 */
export class ModelDailyQuotaTurn {
  private supported = true
  private task = globalThis.crypto.randomUUID()
  private permit?: Promise<string | undefined>
  private authorization?: string
  private heartbeat?: ReturnType<typeof setInterval>
  private finishing?: Promise<void>
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

  async getPermit(headers: Headers, signal: AbortSignal): Promise<string | undefined> {
    if (!this.supported) return undefined
    if (!this.permit) {
      this.finishing = undefined
      const key = headers.get('x-api-key') || headers.get('x-goog-api-key')
      this.authorization = headers.get('authorization') || (key ? `Bearer ${key}` : undefined)
      if (!this.authorization) return undefined
      this.permit = this.begin(signal)
    }
    return this.permit
  }

  private async begin(signal: AbortSignal) {
    const response = await this.request('', { model: this.model, task_id: this.task }, signal)
    if ([404, 405].includes(response.status)) {
      await response.body?.cancel().catch(() => {})
      this.supported = false
      return undefined
    }
    if (!response.ok) throw await this.refusal(response)
    const payload = JSON.parse((await this.refusal(response)).body) as {
      success?: boolean
      data?: { permit?: unknown }
    }
    const permit = payload.data?.permit
    if (payload.success !== true || typeof permit !== 'string' || !/^[a-f0-9]{64}$/.test(permit))
      throw new Error('Invalid model daily quota authorization response')
    this.heartbeat = setInterval(() => {
      void this.request('/state', { model: this.model, permit, close: false })
        .then((response) => response.body?.cancel())
        .catch(() => {
          // The next model call still validates the lease on the server. A failed
          // heartbeat cannot bypass limits or interrupt a healthy ongoing stream.
        })
    }, 60_000)
    this.heartbeat.unref?.()
    return permit
  }

  private request(suffix: string, body: Record<string, unknown>, signal?: AbortSignal) {
    return fetch(`${this.endpoint.href}${suffix}`, {
      method: 'POST',
      headers: { Authorization: this.authorization!, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(5_000),
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

  finish(): Promise<void> {
    if (this.finishing) return this.finishing
    this.finishing = (async () => {
      const pending = this.permit
      const permit = await pending?.catch(() => undefined)
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
      if (permit)
        await this.request('/state', { model: this.model, permit, close: true })
          .then((response) => response.body?.cancel())
          .catch(() => {})
      this.permit = undefined
      this.authorization = undefined
      this.task = globalThis.crypto.randomUUID()
    })()
    return this.finishing
  }
}
