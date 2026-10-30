import { hubMCPServer } from '@renderer/store/mcp'
import type { Assistant, McpMode, MCPServer, MCPTool } from '@renderer/types'
import { getEffectiveMcpMode } from '@renderer/types'

export function selectAssistantMcpServers(assistant: Assistant, servers: MCPServer[]): MCPServer[] {
  const mode = getEffectiveMcpMode(assistant)
  if (mode === 'disabled') return []

  const activeServers = servers.filter((server) => server.isActive && server.id !== hubMCPServer.id)
  if (mode === 'auto') return activeServers.length > 0 ? [hubMCPServer] : []
  if (mode !== 'manual') return []

  const selectedIds = new Set(assistant.mcpServers?.map((server) => server.id))
  return activeServers.filter((server) => selectedIds.has(server.id))
}

/**
 * Keep discovery instructions out of requests without an attached Hub. This
 * also covers unavailable tools, unsupported models and internal generation.
 */
export function getMcpModeForRequest(assistant: Assistant, tools?: MCPTool[]): McpMode {
  const mode = getEffectiveMcpMode(assistant)
  if (mode === 'auto' && !tools?.some((tool) => tool.serverId === hubMCPServer.id)) return 'disabled'
  return mode
}
