export const OPENCODE_MCP_LIMIT = 8
export const DIFY_KNOWLEDGE_MCP = '@cherry/dify-knowledge'
export const DIFY_KNOWLEDGE_TOOLS = ['list_knowledges', 'search_knowledge']

export function isAssistantMcpServer(server: {
  type?: string
  name: string
  baseUrl?: string
  command?: string
  isTrusted?: boolean
}) {
  if (server.type === 'inMemory') return server.name === DIFY_KNOWLEDGE_MCP
  if (!server.isTrusted) return false
  if (server.type === 'streamableHttp' || server.type === 'sse') return Boolean(server.baseUrl)
  return (server.type === 'stdio' || !server.type) && Boolean(server.command)
}
