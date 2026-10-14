import { CacheService } from '@renderer/services/CacheService'

type Selection = { agentId: string; sessionId: string }
type Workspace = 'legacy' | 'opencode'
const key = (workspace: Workspace) => `agent-explicit-entry:${workspace}`

export function markAgentEntrySelection(workspace: Workspace, selection: Selection) {
  CacheService.set(key(workspace), selection, 60_000)
}

export function consumeAgentEntrySelection(workspace: Workspace, selection: Selection): boolean {
  const intended = CacheService.get<Selection>(key(workspace))
  if (!intended || intended.agentId !== selection.agentId || intended.sessionId !== selection.sessionId) return false
  CacheService.remove(key(workspace))
  return true
}
