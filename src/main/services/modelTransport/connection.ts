import { AsyncLocalStorage } from 'node:async_hooks'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { lookup } from 'node:dns'
import type { LookupFunction, Socket } from 'node:net'

import { Agent, buildConnector } from 'undici'

export type ConnectionRecord = (event: string, details: Record<string, unknown>) => void
interface Observation {
  emit: ConnectionRecord
  startedAt: number
}

/** These hooks observe only requests created inside this private transport. */
export class ModelConnectionPool {
  private context = new AsyncLocalStorage<Observation>()
  private requests = new WeakMap<object, Observation>()
  private usedSockets = new WeakSet<Socket>()
  private listeners: Array<[string, (message: any) => void]> = []
  readonly agent: Agent

  constructor() {
    const record = (observation: Observation | undefined, event: string, details: Record<string, unknown>) => {
      try {
        observation?.emit(event, { ...details, elapsedMs: Date.now() - observation.startedAt })
      } catch {
        /* Observation must not affect the request. */
      }
    }
    const ipv4FirstLookup: LookupFunction = (hostname, options, callback) => {
      const observation = this.context.getStore()
      const startedAt = Date.now()
      lookup(hostname, { ...options, all: true }, (error, addresses) => {
        const ordered = (addresses || []).sort((a, b) => a.family - b.family)
        record(observation, 'dns-resolved', {
          durationMs: Date.now() - startedAt,
          ipv4Addresses: ordered.filter((entry) => entry.family === 4).length,
          ipv6Addresses: ordered.filter((entry) => entry.family === 6).length,
          errorCode: error?.code
        })
        if (options.all) callback(error, ordered)
        else callback(error, ordered[0]?.address || '', ordered[0]?.family || 4)
      })
    }
    const connector = buildConnector({
      lookup: ipv4FirstLookup,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
      timeout: 10_000
    })
    this.agent = new Agent({
      connections: 8,
      pipelining: 1,
      // Task/request AbortSignals remain authoritative. Image-download deadlines
      // must not be applied to model reasoning or pauses in an SSE stream.
      headersTimeout: 0,
      bodyTimeout: 0,
      connect: (options, callback) => {
        const observation = this.context.getStore()
        const startedAt = Date.now()
        connector(options, (error, socket) => {
          record(observation, error ? 'connection-failed' : 'connected', {
            durationMs: Date.now() - startedAt,
            remoteAddress: socket?.remoteAddress,
            addressFamily: socket?.remoteFamily,
            attemptedAddresses: socket?.autoSelectFamilyAttemptedAddresses,
            errorCode: (error as NodeJS.ErrnoException | null)?.code
          })
          if (error) callback(error, null)
          else callback(null, socket)
        })
      }
    })
    this.observe('undici:request:create', ({ request }) => {
      const observation = this.context.getStore()
      if (observation) this.requests.set(request, observation)
    })
    this.observe('undici:client:sendHeaders', ({ request, socket }) => {
      const observation = this.requests.get(request)
      if (!observation) return
      record(observation, 'request-write-started', {
        remoteAddress: socket.remoteAddress,
        addressFamily: socket.remoteFamily,
        connectionReused: this.usedSockets.has(socket)
      })
      this.usedSockets.add(socket)
    })
    this.observe('undici:request:bodySent', ({ request }) => {
      record(this.requests.get(request), 'request-sent', {})
    })
  }

  run<T>(emit: ConnectionRecord, send: () => T): T {
    return this.context.run({ emit, startedAt: Date.now() }, send)
  }

  async destroy() {
    for (const [name, listener] of this.listeners) unsubscribe(name, listener)
    this.listeners = []
    await this.agent.destroy()
  }

  private observe(name: string, listener: (message: any) => void) {
    const guarded = (message: unknown) => {
      try {
        listener(message)
      } catch {
        /* Never throw from a diagnostics_channel subscriber. */
      }
    }
    subscribe(name, guarded)
    this.listeners.push([name, guarded])
  }
}
