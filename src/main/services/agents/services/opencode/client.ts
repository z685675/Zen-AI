export type OpenCodeEvent = { type: string; properties: Record<string, any> }

export class OpenCodeClient {
  constructor(
    private url: string,
    private password: string,
    private directory: string
  ) {}

  private headers() {
    return {
      Authorization: `Basic ${Buffer.from(`zen-ai:${this.password}`).toString('base64')}`,
      'Content-Type': 'application/json',
      'x-opencode-directory': encodeURIComponent(this.directory)
    }
  }

  async request<T>(route: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.url}${route}`, {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      // Do not echo config bodies, credentials or arbitrary provider text.
      throw Object.assign(new Error(`OpenCode ${method} ${route.split('?')[0]} returned HTTP ${response.status}`), {
        status: response.status,
        zenFailureStage: 'agent-runtime',
        zenRuntimeId: 'opencode'
      })
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
  }

  async *events(signal: AbortSignal): AsyncGenerator<OpenCodeEvent> {
    const handshake = new AbortController()
    const timer = setTimeout(() => handshake.abort(new Error('OpenCode event handshake timed out')), 15_000)
    const streamSignal = AbortSignal.any([signal, handshake.signal])
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await fetch(`${this.url}/event`, { headers: this.headers(), signal: streamSignal })
      if (!response.ok || !response.body) throw new Error(`OpenCode event stream unavailable (${response.status})`)
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        buffer = buffer.replaceAll('\r\n', '\n')
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (data && data !== '[DONE]') {
            clearTimeout(timer)
            yield JSON.parse(data) as OpenCodeEvent
          }
        }
        if (buffer.length > 8_000_000) throw new Error('OpenCode event frame exceeded the safe size limit')
      }
      if (!signal.aborted) throw new Error('OpenCode event stream disconnected before task completion')
    } finally {
      clearTimeout(timer)
      await reader?.cancel().catch(() => undefined)
    }
  }
}
