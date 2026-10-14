import { DEFAULT_OPENCODE_AGENT_ID } from '../config/agents'

export const LEGACY_ASSISTANT_READ_ONLY_CODE = 'legacy_assistant_read_only'
export const LEGACY_ASSISTANT_READ_ONLY_MESSAGE = '旧助手已停止使用，请切换新智能助手进行使用。'

/** Product boundary, independent of model, runtime overrides and developer mode. */
export function isAssistantExecutionAllowed(agentId: string | null | undefined): boolean {
  return agentId === DEFAULT_OPENCODE_AGENT_ID
}

export function assertAssistantExecutionAllowed(agentId: string | null | undefined): void {
  if (!isAssistantExecutionAllowed(agentId)) {
    throw Object.assign(new Error(LEGACY_ASSISTANT_READ_ONLY_MESSAGE), { code: LEGACY_ASSISTANT_READ_ONLY_CODE })
  }
}
