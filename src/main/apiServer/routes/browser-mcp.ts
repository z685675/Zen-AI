import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import BrowserServer from '@main/mcpServers/browser/server'
import { loggerService } from '@main/services/LoggerService'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types'
import { isJSONRPCRequest, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types'
import type { Request, Response } from 'express'
import express from 'express'

const logger = loggerService.withContext('BrowserMCPRoute')
const CONTEXT_TTL_MS = 60 * 60 * 1000
const SESSION_INIT_TIMEOUT_MS = 30_000

type BrowserContext = {
  updatedAt: number
}

type SessionEntry = {
  contextId: string
  server: BrowserServer
  transport: StreamableHTTPServerTransport
  closed: boolean
}

const contexts = new Map<string, BrowserContext>()
const sessions = new Map<string, SessionEntry>()

function closeSessionEntry(entry: SessionEntry): void {
  if (entry.closed) return
  entry.closed = true
  void entry.server.close().catch((error) => {
    logger.warn('Failed to close Browser MCP session', { error })
  })
}

export function registerBrowserMcpContext(contextId: string): void {
  cleanupBrowserMcpContext(contextId)
  contexts.set(contextId, { updatedAt: Date.now() })
}

export function cleanupBrowserMcpContext(contextId: string): void {
  contexts.delete(contextId)
  for (const [sessionId, entry] of sessions) {
    if (entry.contextId !== contextId) continue
    sessions.delete(sessionId)
    closeSessionEntry(entry)
    void entry.transport.close?.()
  }
}

function cleanupExpiredContexts(): void {
  const cutoff = Date.now() - CONTEXT_TTL_MS
  for (const [contextId, context] of contexts) {
    if (context.updatedAt < cutoff) cleanupBrowserMcpContext(contextId)
  }
}

function createSessionEntry(contextId: string): SessionEntry {
  const server = new BrowserServer()
  const pendingId = `pending:${randomUUID()}`
  let initialized = false
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      initialized = true
      sessions.delete(pendingId)
      sessions.set(newSessionId, entry)
    }
  })
  const entry: SessionEntry = { contextId, server, transport, closed: false }

  sessions.set(pendingId, entry)
  setTimeout(() => {
    if (initialized || !sessions.has(pendingId)) return
    sessions.delete(pendingId)
    closeSessionEntry(entry)
    void transport.close?.()
  }, SESSION_INIT_TIMEOUT_MS)

  transport.onclose = () => {
    sessions.delete(pendingId)
    if (transport.sessionId) sessions.delete(transport.sessionId)
    closeSessionEntry(entry)
  }

  return entry
}

const router: express.Router = express.Router({ mergeParams: true })

router.all('/:contextId/mcp', async (req: Request, res: Response): Promise<void> => {
  cleanupExpiredContexts()
  const contextId = req.params.contextId
  const context = contexts.get(contextId)
  if (!context) {
    res.status(404).json({ error: 'Browser MCP context not found or expired' })
    return
  }
  context.updatedAt = Date.now()

  const sessionId = req.headers['mcp-session-id'] as string | undefined
  let entry = sessionId ? sessions.get(sessionId) : undefined

  if (!entry || entry.contextId !== contextId) {
    entry = createSessionEntry(contextId)
    await entry.server.mcpServer.connect(entry.transport)
  }

  if (req.method === 'POST') {
    const jsonPayload = req.body
    const messages: JSONRPCMessage[] = []
    if (Array.isArray(jsonPayload)) {
      for (const payload of jsonPayload) messages.push(JSONRPCMessageSchema.parse(payload))
    } else {
      messages.push(JSONRPCMessageSchema.parse(jsonPayload))
    }

    for (const message of messages) {
      if (!isJSONRPCRequest(message)) continue
      message.params ??= {}
      message.params._meta ??= {}
      message.params._meta.browserContextId = contextId
    }

    logger.debug('Dispatching Browser MCP POST request', {
      contextId,
      sessionId: entry.transport.sessionId ?? sessionId,
      messageCount: messages.length
    })
    await entry.transport.handleRequest(req as IncomingMessage, res as ServerResponse, messages)
    return
  }

  await entry.transport.handleRequest(req as IncomingMessage, res as ServerResponse)
})

export { router as browserMcpRoutes }
