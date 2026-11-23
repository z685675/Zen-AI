import { isNewAssistantAgentId } from '@shared/config/agents'

export const LEGACY_CONVERSATIONS_PATH = '/new-assistant?history=legacy'

export type LegacyConversation = { agentId: string; sessionId: string }

export function getLegacyConversationPath({ agentId, sessionId }: LegacyConversation): string {
  const query = new URLSearchParams({ agent: agentId, session: sessionId })
  return `${LEGACY_CONVERSATIONS_PATH}&${query}`
}

export function readLegacyConversation(query: URLSearchParams): LegacyConversation | undefined {
  const agentId = query.get('agent')
  const sessionId = query.get('session')
  const validId = /^[\w-]+$/
  if (!agentId || !sessionId || isNewAssistantAgentId(agentId) || !validId.test(agentId) || !validId.test(sessionId)) {
    return undefined
  }
  return { agentId, sessionId }
}
