import mcpService from '@main/services/MCPService'
import { reduxService } from '@main/services/ReduxService'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  DIFY_KNOWLEDGE_MCP,
  DIFY_KNOWLEDGE_TOOLS,
  isAssistantMcpServer,
  OPENCODE_MCP_LIMIT
} from '@shared/agents/opencodeMcp'
import type { MCPServer } from '@types'

import { assistantMcpAlias } from './config'

async function configuredServers() {
  return (await reduxService.select<MCPServer[]>('state.mcp.servers')) ?? []
}

export async function resolveAssistantMcpIds(ids: string[] | undefined) {
  if (!ids?.length) return []
  const servers = await configuredServers().catch(() => [])
  return [...new Set(ids)]
    .filter((id) => servers.some((server) => server.id === id && server.isActive && isAssistantMcpServer(server)))
    .slice(0, OPENCODE_MCP_LIMIT)
}

export function assistantMcpToolAllowed(server: MCPServer, name: string) {
  return (
    !server.disabledTools?.includes(name) &&
    (server.type !== 'inMemory' || (server.name === DIFY_KNOWLEDGE_MCP && DIFY_KNOWLEDGE_TOOLS.includes(name)))
  )
}

async function getAllowedServer(id: string) {
  const config = (await configuredServers()).find((server) => server.id === id)
  if (!config?.isActive || !isAssistantMcpServer(config)) throw new Error('MCP connection is disabled or unavailable')
  return config
}

export async function probeAssistantMcp(id: string) {
  const config = await getAllowedServer(id)
  const client = await mcpService.initClient(config)
  const signal = AbortSignal.timeout(12_000)
  const names: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < 8 && names.length < 100; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined, { signal })
    names.push(...result.tools.filter((tool) => assistantMcpToolAllowed(config, tool.name)).map((tool) => tool.name))
    cursor = result.nextCursor
    if (!cursor) break
  }
  return names.slice(0, 100)
}

export function createAssistantIntegration(id: string, getSignal: () => AbortSignal | undefined) {
  const server = new Server({ name: assistantMcpAlias(id), version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const config = await getAllowedServer(id)
    const client = await mcpService.initClient(config)
    const result = await client.listTools(request.params?.cursor ? { cursor: request.params.cursor } : undefined, {
      signal: extra.signal
    })
    return { ...result, tools: result.tools.filter((tool) => assistantMcpToolAllowed(config, tool.name)) }
  })
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const turn = getSignal()
    if (!turn) throw new Error('No active assistant turn')
    const signal = AbortSignal.any([turn, extra.signal])
    signal.throwIfAborted()
    const config = await getAllowedServer(id)
    const { name, arguments: args } = request.params
    if (!assistantMcpToolAllowed(config, name)) throw new Error('MCP tool is disabled')
    const client = await mcpService.initClient(config)
    signal.throwIfAborted()
    return client.callTool({ name, arguments: args }, CallToolResultSchema, {
      signal,
      timeout: Math.min(120_000, Math.max(1000, (config.timeout ?? 60) * 1000))
    })
  })
  return server
}
