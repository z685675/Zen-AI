import mcpService from '@main/services/MCPService'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { MCPServer } from '@types'

import { loggerService } from '../../services/LoggerService'
import { reduxService } from '../../services/ReduxService'

const logger = loggerService.withContext('MCPApiService')

async function getActiveClient(id: string) {
  const server = (await getMCPServersFromRedux()).find((candidate) => candidate.id === id && candidate.isActive)
  if (!server) throw new Error(`Server not found: ${id}`)
  return mcpService.initClient(server)
}

export async function getMCPServersFromRedux(): Promise<MCPServer[]> {
  try {
    return (await reduxService.select<MCPServer[]>('state.mcp.servers')) || []
  } catch (error) {
    logger.error('Failed to get servers from Redux store', { error })
    return []
  }
}

/**
 * Creates a fresh MCP Server instance for a given server ID.
 *
 * A new Server is created for each transport session because the MCP SDK's
 * Protocol.connect() throws "Already connected" if the Server is already
 * bound to a transport. Since the Claude Agent SDK spawns a new CLI process
 * per query (including resumes), each process establishes a new HTTP
 * transport, so the proxy must provide a fresh Server instance every time.
 */
export async function createMcpServerForTransport(id: string): Promise<Server> {
  const servers = await getMCPServersFromRedux()
  const mcpServer = servers.find((server) => server.id === id && server.isActive)
  if (!mcpServer) {
    throw new Error(`Server not found: ${id}`)
  }

  const server = new Server({ name: mcpServer.name, version: '0.1.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => (await getActiveClient(id)).listTools())
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    (await getActiveClient(id)).callTool(request.params)
  )
  return server
}
