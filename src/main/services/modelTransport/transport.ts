import { isRoutableApiRequest } from '@shared/clientConnections'
import { isManagedModelRequest, transportError } from '@shared/modelTransport'
import { fetch as nodeFetch } from 'undici'

import { type ConnectionRecord, ModelConnectionPool } from './connection'

export class ModelApiTransport {
  private pool?: ModelConnectionPool
  resolveProxy?: (url: string) => Promise<string>
  route?: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    send: typeof fetch,
    record: ConnectionRecord
  ) => Promise<Response>

  async fetch(
    input: RequestInfo | URL,
    init?: RequestInit,
    record: ConnectionRecord = () => {},
    nativeFetch: typeof fetch = globalThis.fetch
  ): Promise<Response> {
    if (this.route && !(input instanceof Request)) {
      const url = input instanceof URL ? input.href : input
      if (isRoutableApiRequest(url, init?.method))
        return this.route(
          input,
          init,
          (target, options) => this.send(target, options, record, nativeFetch, true),
          record
        )
    }
    return this.send(input, init, record, nativeFetch)
  }

  private async send(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    record: ConnectionRecord,
    nativeFetch: typeof fetch,
    routed = false
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method || (input instanceof Request ? input.method : 'GET')
    const emit: ConnectionRecord = (event, details) => {
      try {
        record(event, details)
      } catch {
        /* A diagnostic callback must not prevent generation. */
      }
    }
    if (input instanceof Request || (!routed && !isManagedModelRequest(url, method)) || !this.resolveProxy)
      return nativeFetch(input, init)
    init?.signal?.throwIfAborted()
    let proxy: string | undefined
    try {
      proxy = await this.resolveProxy(url)
    } catch {
      /* Uncertain proxy state must stay on the existing proxy-aware path. */
    }
    init?.signal?.throwIfAborted()
    if (proxy?.trim() !== 'DIRECT') {
      emit('connection-strategy', { addressStrategy: 'default', proxyConfigured: proxy !== undefined })
      return nativeFetch(input, init)
    }
    emit('connection-strategy', { addressStrategy: 'ipv4-preferred', proxyConfigured: false })
    this.pool ??= new ModelConnectionPool()
    try {
      // Happy Eyeballs chooses a connected socket BEFORE any HTTP request is
      // written. Never retry fetch after a POST has possibly reached the API.
      return (await this.pool.run(emit, () =>
        nodeFetch(url, {
          ...init,
          headers: Array.from(new Headers(init?.headers).entries()),
          dispatcher: this.pool!.agent
        } as Parameters<typeof nodeFetch>[1])
      )) as unknown as Response
    } catch (error) {
      emit('connection-request-failed', { error: transportError(error) })
      throw error
    }
  }

  async destroy() {
    const pool = this.pool
    this.pool = undefined
    await pool?.destroy()
  }
}

export const modelApiTransport = new ModelApiTransport()
