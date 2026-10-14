import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { createContext, type PropsWithChildren, use } from 'react'

export const AgentWorkspaceContext = createContext<'legacy' | 'opencode'>('legacy')
export const useAgentWorkspace = () => use(AgentWorkspaceContext)

export function agentBelongsToWorkspace(agentId: string | null, workspace: 'legacy' | 'opencode'): boolean {
  return Boolean(
    agentId &&
      (workspace === 'opencode' ? agentId === DEFAULT_OPENCODE_AGENT_ID : agentId !== DEFAULT_OPENCODE_AGENT_ID)
  )
}

export function AgentWorkspaceBoundary({ agentId, children }: PropsWithChildren<{ agentId: string }>) {
  return (
    <AgentWorkspaceContext value={agentId === DEFAULT_OPENCODE_AGENT_ID ? 'opencode' : 'legacy'}>
      {children}
    </AgentWorkspaceContext>
  )
}
