export function getAgentSessionDraftCacheKey(agentId: string, sessionId: string): string {
  return `agent-session-draft:${encodeURIComponent(agentId)}:${encodeURIComponent(sessionId)}`
}
