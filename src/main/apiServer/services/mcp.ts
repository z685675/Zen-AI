import mcpService from '@main/services/MCPService'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types'
import { isInitializeRequest, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types'
import type { MCPServer } from '@types'
import { randomUUID } from 'crypto'
import type { Request, Response } from 'express'
import type { IncomingMessage, ServerResponse } from 'http'

import { loggerService } from '../../services/LoggerService'
import { createMcpServerForTransport, getMCPServersFromRedux } from '../utils/mcp'

const logger = loggerService.withContext('MCPApiService')
const MCP_IDLE_TIMEOUT_MS = 30 * 60_000
const MAX_MCP_SESSIONS = 128

type McpSession = {
  serverId: string
  transport: StreamableHTTPServerTransport
  timer?: ReturnType<typeof setTimeout>
}

interface McpServerDTO {
  id: MCPServer['id']
  name: MCPServer['name']
  type: MCPServer['type']
  description: MCPServer['description']
  url: string
}

interface McpServersResp {
  servers: Record<string, McpServerDTO>
}

/**
 * MCPApiService - API layer for MCP server management
 *
 * This service provides a REST API interface for MCP servers while integrating
 * with the existing application architecture:
 *
 * 1. Uses ReduxService to access the renderer's Redux store directly
 * 2. Syncs changes back to the renderer via Redux actions
 * 3. Leverages existing MCPService for actual server connections
 * 4. Provides session management for API clients
 */
class MCPApiService {
  private sessions = new Map<string, McpSession>()
  private connecting = 0

  // get all activated servers
  async getAllServers(req: Request): Promise<McpServersResp> {
    try {
      const servers = await getMCPServersFromRedux()
      logger.debug('Returning servers from Redux', { count: servers.length })
      const resp: McpServersResp = {
        servers: {}
      }
      for (const server of servers) {
        if (server.isActive) {
          resp.servers[server.id] = {
            id: server.id,
            name: server.name,
            type: 'streamableHttp',
            description: server.description,
            url: `${req.protocol}://${req.host}/v1/mcps/${server.id}/mcp`
          }
        }
      }
      return resp
    } catch (error: any) {
      logger.error('Failed to get all servers', { error })
      throw new Error('Failed to retrieve servers')
    }
  }

  // get server by id
  async getServerById(id: string): Promise<MCPServer | null> {
    try {
      logger.debug('getServerById called', { id })
      const servers = await getMCPServersFromRedux()
      const server = servers.find((s) => s.id === id)
      if (!server) {
        logger.warn('Server not found', { id })
        return null
      }
      logger.debug('Returning server', { id })
      return server
    } catch (error: any) {
      logger.error('Failed to get server', { id, error })
      throw new Error('Failed to retrieve server')
    }
  }

  async getServerInfo(id: string): Promise<any> {
    try {
      const server = await this.getServerById(id)
      if (!server) {
        logger.warn('Server not found while fetching info', { id })
        return null
      }

      const client = await mcpService.initClient(server)
      const tools = await client.listTools()
      return {
        id: server.id,
        name: server.name,
        type: server.type,
        description: server.description,
        tools: tools.tools
      }
    } catch (error: any) {
      logger.error('Failed to get server info', { id, error })
      throw new Error('Failed to retrieve server info')
    }
  }

  async handleRequest(req: Request, res: Response, server: MCPServer) {
    if (!server.isActive) return res.sendStatus(404)
    const rawSessionId = req.headers['mcp-session-id']
    const existing = typeof rawSessionId === 'string' ? this.sessions.get(rawSessionId) : undefined
    if (rawSessionId !== undefined && existing?.serverId !== server.id) return res.sendStatus(404)

    let messages: JSONRPCMessage[] | undefined
    if (req.method === 'POST') {
      const payload = Array.isArray(req.body) ? req.body : [req.body]
      const parsed = JSONRPCMessageSchema.array().min(1).safeParse(payload)
      if (!parsed.success) return res.sendStatus(400)
      messages = parsed.data
    }

    if (existing) {
      this.refreshSession(existing)
      return existing.transport.handleRequest(req as IncomingMessage, res as ServerResponse, messages)
    }
    if (req.method !== 'POST' || messages?.length !== 1 || !isInitializeRequest(messages[0])) {
      return res.sendStatus(400)
    }
    if (this.sessions.size + this.connecting >= MAX_MCP_SESSIONS) return res.sendStatus(503)
    this.connecting++

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        this.sessions.set(id, entry)
        this.refreshSession(entry)
      }
    })
    const entry: McpSession = { serverId: server.id, transport }
    transport.onclose = () => {
      clearTimeout(entry.timer)
      if (transport.sessionId) this.sessions.delete(transport.sessionId)
    }
    try {
      const mcpServer = await createMcpServerForTransport(server.id)
      await mcpServer.connect(transport)
      await transport.handleRequest(req as IncomingMessage, res as ServerResponse, messages[0])
    } finally {
      this.connecting--
      if (!transport.sessionId) await transport.close()
    }
  }

  private refreshSession(entry: McpSession): void {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      void entry.transport.close().catch((error) => logger.warn('Failed to close expired MCP session', { error }))
    }, MCP_IDLE_TIMEOUT_MS)
    entry.timer.unref()
  }
}

export const mcpApiService = new MCPApiService()
