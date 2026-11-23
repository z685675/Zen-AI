export const OPENCODE_SUBAGENT_CONCURRENCY = 2
export const OPENCODE_SUBAGENT_TURN_LIMIT = 16

export type OpenCodeSubagentProgress = {
  id: string
  description: string
  agent: string
  status: 'queued' | 'running' | 'waiting_permission' | 'waiting_answer' | 'completed' | 'failed' | 'cancelled'
  toolCalls: number
  lastTool?: string
  background?: boolean
}

export function readOpenCodeSubagents(value: unknown): OpenCodeSubagentProgress[] | undefined {
  if (!Array.isArray(value) || value.length > OPENCODE_SUBAGENT_TURN_LIMIT) return
  const statuses = ['queued', 'running', 'waiting_permission', 'waiting_answer', 'completed', 'failed', 'cancelled']
  const result: OpenCodeSubagentProgress[] = []
  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      item.id.length > 256 ||
      typeof item.description !== 'string' ||
      item.description.length > 500 ||
      typeof item.agent !== 'string' ||
      item.agent.length > 80 ||
      !statuses.includes(item.status) ||
      !Number.isSafeInteger(item.toolCalls) ||
      item.toolCalls < 0 ||
      (item.background !== undefined && typeof item.background !== 'boolean') ||
      (item.lastTool !== undefined && (typeof item.lastTool !== 'string' || item.lastTool.length > 256))
    )
      return
    result.push({
      id: item.id,
      description: item.description,
      agent: item.agent,
      status: item.status,
      toolCalls: item.toolCalls,
      ...(item.background ? { background: true } : {}),
      ...(item.lastTool ? { lastTool: item.lastTool } : {})
    })
  }
  return result
}
