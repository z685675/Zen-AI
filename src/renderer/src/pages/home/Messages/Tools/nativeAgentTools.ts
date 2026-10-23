import type { MCPToolResponse, NormalToolResponse } from '@renderer/types'

// OpenCode's native tools are lower-case provider tools, not renderer-side MCP calls.
// Keep the original names/arguments: e.g. write.filePath != legacy Write.file_path.
const nativeNames = new Set([
  'read',
  'write',
  'edit',
  'apply_patch',
  'bash',
  'glob',
  'grep',
  'task',
  'skill',
  'todowrite',
  'webfetch',
  'websearch',
  'question',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource'
])

export function isNativeAgentTool(response: MCPToolResponse | NormalToolResponse | undefined): boolean {
  return response?.tool?.type === 'provider' && nativeNames.has(response.tool.name)
}
