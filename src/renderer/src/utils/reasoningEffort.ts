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
