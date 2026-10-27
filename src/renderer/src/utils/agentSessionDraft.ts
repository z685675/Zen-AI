import { loggerService } from '@logger'
import { CacheService } from '@renderer/services/CacheService'

const logger = loggerService.withContext('AgentSessionDraft')

export function getAgentSessionDraftCacheKey(agentId: string, sessionId: string): string {
  return `agent-session-draft:${encodeURIComponent(agentId)}:${encodeURIComponent(sessionId)}`
}

export function getAgentSessionDraft(agentId: string, sessionId: string): string {
  const key = getAgentSessionDraftCacheKey(agentId, sessionId)
  const cached = CacheService.get<string>(key)
  if (cached !== null) return cached

  try {
    return localStorage.getItem(key) ?? ''
  } catch (error) {
    logger.warn('Failed to read the local session draft', error as Error)
    return ''
  }
}

export function saveAgentSessionDraft(agentId: string, sessionId: string, text: string): void {
  const key = getAgentSessionDraftCacheKey(agentId, sessionId)
  // Keep the live draft even if local storage is unavailable or full.
  CacheService.set(key, text, Number.POSITIVE_INFINITY)
  try {
    if (text.length > 0) {
      localStorage.setItem(key, text)
    } else {
      localStorage.removeItem(key)
    }
  } catch (error) {
    logger.warn('Failed to save the local session draft', error as Error)
  }
}

export function clearAgentSessionDraft(agentId: string, sessionId: string): void {
  saveAgentSessionDraft(agentId, sessionId, '')
}
