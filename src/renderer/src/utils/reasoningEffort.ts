import type { AgentEffort, ThinkingOption } from '@renderer/types'

export const CHAT_REASONING_EFFORT_OPTIONS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh'
] as const satisfies readonly ThinkingOption[]

export const AGENT_REASONING_EFFORT_OPTIONS = [
  'low',
  'medium',
  'high',
  'xhigh'
] as const satisfies readonly ThinkingOption[]

export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORT_OPTIONS)[number]

export const AGENT_DEFAULT_REASONING_EFFORT = 'medium' satisfies AgentReasoningEffort

export function getAgentSessionReasoningEffortCacheKey(agentId: string, sessionId: string): string {
  return `agent-session-reasoning-effort:${encodeURIComponent(agentId)}:${encodeURIComponent(sessionId)}`
}

export function normalizeChatReasoningEffort(option?: ThinkingOption): ThinkingOption {
  switch (option) {
    case 'none':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return option
    case 'minimal':
      return 'low'
    case 'auto':
    case 'default':
    default:
      return 'medium'
  }
}

export function normalizeAgentReasoningEffort(option?: ThinkingOption): AgentReasoningEffort {
  switch (option) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return option
    case 'none':
    case 'minimal':
    case 'auto':
    case 'default':
    default:
      return AGENT_DEFAULT_REASONING_EFFORT
  }
}

export function toAgentEffort(option: ThinkingOption): AgentEffort {
  switch (option) {
    case 'xhigh':
      return 'max'
    case 'medium':
    case 'high':
      return option
    case 'none':
    case 'minimal':
    case 'auto':
    case 'default':
    case 'low':
    default:
      return 'low'
  }
}
