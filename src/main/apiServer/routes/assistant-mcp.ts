import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import AssistantServer from '@main/mcpServers/assistant'
import type { AssistantProductOptions } from '@main/mcpServers/assistantProductTools'
import type { AssistantFileChangeTurn } from '@main/services/agents/services/opencode/fileChanges'
import { loggerService } from '@main/services/LoggerService'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types'
import { isJSONRPCRequest, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types'
import type { Request, Response } from 'express'
import express from 'express'

const logger = loggerService.withContext('AssistantMCPRoute')
const CONTEXT_TTL_MS = 60 * 60 * 1000
const SESSION_INIT_TIMEOUT_MS = 30_000

type AssistantContext = {
  allowedRoots: string[]
  updatedAt: number
  product?: AssistantProductOptions
  observeArguments?: (name: string, input: unknown, requestId: string) => void
  integrationIds: ReadonlySet<string>
  fileChanges?: { token: string; current: () => AssistantFileChangeTurn | undefined }
}

type SessionEntry = {
  contextId: string
  server: Pick<AssistantServer['mcpServer'], 'connect' | 'close'>
  transport: StreamableHTTPServerTransport
  integrationId?: string
}

const contexts = new Map<string, AssistantContext>()
const sessions = new Map<string, SessionEntry>()

export function registerAssistantMcpContext(
  contextId: string,
  allowedRoots: string[],
  product?: AssistantProductOptions,
  observeArguments?: AssistantContext['observeArguments'],
  integrationIds: string[] = [],
  fileChanges?: AssistantContext['fileChanges']
): void {
  // A session can be invoked again after a cancelled or interrupted turn. Drop any
  // stale transport before replacing its authorization context.
  cleanupAssistantMcpContext(contextId)
  contexts.set(contextId, {
    allowedRoots: [...new Set(allowedRoots.filter(Boolean).map((root) => path.resolve(root)))],
    updatedAt: Date.now(),
    product,
    observeArguments,
    integrationIds: new Set(integrationIds),
    fileChanges
  })
}

export function cleanupAssistantMcpContext(contextId: string): void {
  contexts.delete(contextId)
  for (const [sessionId, entry] of sessions) {
    if (entry.contextId !== contextId) continue
    sessions.delete(sessionId)
    void entry.transport.close?.()
    void entry.server.close()
  }
}

export function touchAssistantMcpContext(contextId: string): boolean {
  const context = contexts.get(contextId)
  if (context) context.updatedAt = Date.now()
  return Boolean(context)
}

function cleanupExpiredContexts(): void {
  const cutoff = Date.now() - CONTEXT_TTL_MS
  for (const [contextId, context] of contexts) {
    if (context.updatedAt < cutoff) cleanupAssistantMcpContext(contextId)
  }
}

async function createSessionEntry(
  contextId: string,
  context: AssistantContext,
  integrationId?: string
): Promise<SessionEntry> {
  const server = integrationId
    ? (await import('@main/services/agents/services/opencode/mcpIntegrations')).createAssistantIntegration(
        integrationId,
        () => context.product?.signal
      )
    : new AssistantServer(context.allowedRoots, context.product).mcpServer
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
  const entry: SessionEntry = { contextId, server, transport, integrationId }

  sessions.set(pendingId, entry)
  setTimeout(() => {
    if (initialized || !sessions.has(pendingId)) return
    sessions.delete(pendingId)
    void transport.close?.()
    void server.close()
  }, SESSION_INIT_TIMEOUT_MS)

  transport.onclose = () => {
    sessions.delete(pendingId)
    if (transport.sessionId) sessions.delete(transport.sessionId)
  }

  return entry
}

const router: express.Router = express.Router({ mergeParams: true })

router.post('/:contextId/file-changes', async (req, res) => {
  const tracker = contexts.get(req.params.contextId)?.fileChanges
  const turn = tracker && req.get('x-zen-file-change-token') === tracker.token ? tracker.current() : undefined
  if (!turn) {
    res.sendStatus(404)
    return
  }
  const { action, callId, files } = req.body ?? {}
  if (typeof callId !== 'string' || callId.length > 512 || !callId) {
    res.sendStatus(400)
    return
  }
  if (
    action === 'begin' &&
    Array.isArray(files) &&
    files.length <= 32 &&
    files.every((file) => typeof file === 'string' && file.length <= 4096)
  ) {
    await turn.begin(callId, files)
  } else if (action === 'finish') {
    await turn.finish(callId)
  } else {
    res.sendStatus(400)
    return
  }
  res.sendStatus(204)
})

router.all(
  ['/:contextId/mcp', '/:contextId/integrations/:integrationId/mcp'],
  async (req: Request, res: Response): Promise<void> => {
    cleanupExpiredContexts()
    const contextId = req.params.contextId
    const integrationId = req.params.integrationId
    const context = contexts.get(contextId)
    if (
      !context ||
      (integrationId &&
        (!context.integrationIds.has(integrationId) ||
          !context.fileChanges?.token ||
          req.get('x-zen-assistant-bridge-token') !== context.fileChanges.token))
    ) {
      res.status(404).json({ error: 'Assistant MCP context not found or expired' })
      return
    }
    context.updatedAt = Date.now()

    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let entry = sessionId ? sessions.get(sessionId) : undefined

    if (sessionId && (entry?.contextId !== contextId || entry.integrationId !== integrationId)) {
      res.status(404).json({ error: 'Assistant MCP session not found' })
      return
    }
    if (!entry) {
      entry = await createSessionEntry(contextId, context, integrationId)
      await entry.server.connect(entry.transport)
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
        if (!integrationId && message.method === 'tools/call' && typeof message.params?.name === 'string') {
          try {
            context.observeArguments?.(message.params.name, message.params.arguments, String(message.id).slice(0, 200))
          } catch {
            /* Metadata collection cannot block a tool. */
          }
        }
        message.params ??= {}
        message.params._meta ??= {}
        message.params._meta.assistantContextId = contextId
      }

      logger.debug('Dispatching Assistant MCP POST request', {
        contextId,
        sessionId: entry.transport.sessionId ?? sessionId,
        messageCount: messages.length
      })
      await entry.transport.handleRequest(req as IncomingMessage, res as ServerResponse, messages)
      return
    }

    await entry.transport.handleRequest(req as IncomingMessage, res as ServerResponse)
  }
)

export { router as assistantMcpRoutes }
