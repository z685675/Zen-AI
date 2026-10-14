import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'

import { OpenCodeUsageObserver } from './usageObservation'

export type TransportEvent = (operationId: string | undefined, event: string, details: Record<string, unknown>) => void

/** Byte-transparent local forwarding: native SDK keeps its protocol/Agent loop.
 * Reuses Zen's proxy-aware fetch and attaches per-turn diagnostics without
 * restarting OpenCode or writing provider credentials into project files.
 */
export async function createOpenCodeGateway(baseURL: string, record: TransportEvent) {
  const target = new URL(baseURL)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
    throw new Error('Unsupported new assistant Provider address')
  const token = randomBytes(32).toString('hex')
  const active = new Set<AbortController>()
  let operationId: string | undefined
  let taskId = `task_${randomUUID()}`
  const emit = (id: string | undefined, event: string, details: Record<string, unknown>) => {
    try {
      record(id, event, details)
    } catch {
      /* Diagnostic failures never break generation. */
    }
  }
  const server = createServer(async (req, res) => {
    if (req.headers['x-zen-runtime-token'] !== token) {
      res.writeHead(401).end()
      return
    }
    const controller = new AbortController()
    active.add(controller)
    const id = operationId
    const requestTaskId = taskId
    const started = Date.now()
    let upstreamStatus: number | undefined
    let usageObserver: OpenCodeUsageObserver | undefined
    let bodyComplete = false
    const upstream = new URL(req.url || '/', target.origin)
    if (upstream.origin !== target.origin || !upstream.pathname.startsWith(target.pathname.replace(/\/$/, '') + '/')) {
      active.delete(controller)
      res.writeHead(400).end()
      return
    }
    const abort = () => {
      if (!res.writableFinished) controller.abort('Native client disconnected')
    }
    req.once('aborted', abort)
    res.once('close', abort)
    try {
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (
          [
            'host',
            'connection',
            'content-length',
            'transfer-encoding',
            'x-zen-runtime-token',
            'x-zen-task-id',
            'x-zen-diagnostic-operation'
          ].includes(name) ||
          value === undefined
        )
          continue
        headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      if (id) headers.set('X-Zen-Diagnostic-Operation', id)
      headers.set('X-Zen-Task-Id', requestTaskId)
      emit(id, 'request-started', { runtime: 'opencode', url: upstream.href, method: req.method })
      const response = await fetch(upstream, {
        method: req.method,
        headers,
        ...(req.method === 'GET' || req.method === 'HEAD'
          ? {}
          : { body: Readable.toWeb(boundedBody(req)), duplex: 'half' as const }),
        signal: controller.signal,
        redirect: 'manual'
      } as RequestInit)
      const requestId = response.headers.get('x-oneapi-request-id') || response.headers.get('x-request-id')
      upstreamStatus = response.status
      usageObserver = new OpenCodeUsageObserver(response.headers.get('content-type') ?? '')
      emit(id, 'headers-received', {
        runtime: 'opencode',
        url: upstream.href,
        status: response.status,
        requestId,
        traceId: response.headers.get('x-zen-trace-id'),
        gateway: Boolean(response.headers.get('x-oneapi-request-id')),
        durationMs: Date.now() - started
      })
      res.statusCode = response.status
      response.headers.forEach((value, name) => {
        // fetch already decoded gzip; preserve body bytes, not stale encoding.
        if (!['connection', 'transfer-encoding', 'content-length', 'content-encoding', 'set-cookie'].includes(name))
          if (!(name === 'location' && response.status >= 300 && response.status < 400))
            // Do not let the native client's automatic redirect escape this
            // authenticated bridge and carry custom headers to another origin.
            res.setHeader(name, value)
      })
      res.flushHeaders()
      if (response.body) {
        for await (const chunk of Readable.fromWeb(response.body as any)) {
          try {
            usageObserver.push(chunk)
          } catch {
            /* Observation cannot interrupt forwarding. */
          }
          if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal })
        }
      }
      res.end()
      bodyComplete = true
      emit(id, 'body-complete', { runtime: 'opencode', status: response.status, durationMs: Date.now() - started })
    } catch (error) {
      emit(id, controller.signal.aborted ? 'cancelled' : 'failed', {
        runtime: 'opencode',
        error,
        url: `${upstream.origin}${upstream.pathname}`,
        receivedResponse: upstreamStatus !== undefined,
        ...(upstreamStatus !== undefined ? { status: upstreamStatus } : {}),
        durationMs: Date.now() - started
      })
      if (!res.headersSent) res.writeHead(502).end('Zen AI could not connect to the model service')
      else res.destroy()
    } finally {
      try {
        emit(
          id,
          'usage-observed',
          usageObserver?.finish(bodyComplete) ?? { usage: {}, format: 'unknown', complete: false }
        )
      } catch {
        /* Observations must not interrupt transport cleanup. */
      }
      active.delete(controller)
      req.off('aborted', abort)
      res.off('close', abort)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  return {
    baseURL: `http://127.0.0.1:${port}${target.pathname.replace(/\/$/, '')}`,
    token,
    setOperation: (value: string | undefined) => {
      operationId = value
      taskId = value || `task_${randomUUID()}`
    },
    stop: () => {
      for (const controller of active) controller.abort('Runtime stopped')
      server.closeAllConnections()
      server.close()
    }
  }
}

function boundedBody(req: IncomingMessage): Readable {
  return Readable.from(
    (async function* () {
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 64 * 1024 * 1024) throw new Error('New assistant request exceeded 64 MiB safety limit')
        yield chunk
      }
    })()
  )
}
