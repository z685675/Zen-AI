import { isAssistantExecutionAllowed } from '@shared/agents/assistantAvailability'

import { isAgentSessionTopicId } from './agentSession'

/** Deprecated sessions and imported SDK steps are view-only. Fail closed for new actions. */
export function canUseLegacyMessageAction(action: string): boolean {
  return ['copy', 'more-menu', 'notes', 'trace', 'inspect-data'].includes(action)
}

export function isReadOnlyLegacySession(topicId: string, agentId: string): boolean {
  return isAgentSessionTopicId(topicId) && !isAssistantExecutionAllowed(agentId)
}
