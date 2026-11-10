import { DEFAULT_DSH_AGENT_ID, DEFAULT_OPENCODE_AGENT_ID, isNewAssistantAgentId } from '@shared/config/agents'
import type { AgentWorkspace } from '@shared/dshPreview'
import { createContext, type PropsWithChildren, use } from 'react'

export const AgentWorkspaceContext = createContext<AgentWorkspace>('legacy')
export const useAgentWorkspace = () => use(AgentWorkspaceContext)

export function agentBelongsToWorkspace(agentId: string | null, workspace: AgentWorkspace): boolean {
  return Boolean(
    agentId &&
      (workspace === 'opencode'
        ? agentId === DEFAULT_OPENCODE_AGENT_ID
        : workspace === 'dsh'
          ? agentId === DEFAULT_DSH_AGENT_ID
          : !isNewAssistantAgentId(agentId))
  )
}

export function AgentWorkspaceBoundary({ agentId, children }: PropsWithChildren<{ agentId: string }>) {
  return (
    <AgentWorkspaceContext
      value={agentId === DEFAULT_OPENCODE_AGENT_ID ? 'opencode' : agentId === DEFAULT_DSH_AGENT_ID ? 'dsh' : 'legacy'}>
      {children}
    </AgentWorkspaceContext>
  )
}
