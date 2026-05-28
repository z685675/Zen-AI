export const DEFAULT_CHERRY_CLAW_AGENT_ID = 'cherry-claw-default'
export const DEFAULT_CHERRY_ASSISTANT_AGENT_ID = 'cherry-assistant-default'
export const DEFAULT_FUSION_AGENT_ID = 'lobster-fusion-default'
export const DEFAULT_FUSION_AGENT_NAME = '官方助手'
export const DEFAULT_FUSION_AGENT_AVATAR = '❤️'
export const DEFAULT_AGENT_AVATAR = '🩶'
export const DEPRECATED_AGENT_NAME_PREFIX = '（请弃用）'

export const PREFERRED_AGENT_IDS = [DEFAULT_FUSION_AGENT_ID] as const

export const BUILTIN_AGENT_IDS = [DEFAULT_FUSION_AGENT_ID] as const

export const PROTECTED_AGENT_IDS = [DEFAULT_FUSION_AGENT_ID] as const

export function isProtectedAgentId(agentId: string | null | undefined): boolean {
  return !!agentId && PROTECTED_AGENT_IDS.includes(agentId as (typeof PROTECTED_AGENT_IDS)[number])
}

export function canCreateAgentSession(agentId: string | null | undefined): boolean {
  return agentId === DEFAULT_FUSION_AGENT_ID
}

export function isBuiltinAgentId(agentId: string | null | undefined): boolean {
  return !!agentId && BUILTIN_AGENT_IDS.includes(agentId as (typeof BUILTIN_AGENT_IDS)[number])
}

export function getAgentAvatar(agentId: string | null | undefined, avatar?: string | null): string {
  void avatar
  if (agentId === DEFAULT_FUSION_AGENT_ID) {
    return DEFAULT_FUSION_AGENT_AVATAR
  }

  return DEFAULT_AGENT_AVATAR
}

export function getPreferredAgentId<T extends { id: string }>(agents: T[] | null | undefined): string | null {
  if (!agents || agents.length === 0) {
    return null
  }

  for (const preferredId of PREFERRED_AGENT_IDS) {
    const match = agents.find((agent) => agent.id === preferredId)
    if (match) {
      return match.id
    }
  }

  return agents[0]?.id ?? null
}
