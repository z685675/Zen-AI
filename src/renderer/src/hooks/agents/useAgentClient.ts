import { AgentApiClient } from '@renderer/api/agent'
import { useAgentWorkspace } from '@renderer/context/AgentWorkspaceProvider'
import { useMemo } from 'react'

import { useSettings } from '../useSettings'

export const useAgentClient = (workspaceOverride?: 'opencode' | 'legacy') => {
  const { apiServer } = useSettings()
  const { host, port, apiKey } = apiServer
  const currentWorkspace = useAgentWorkspace()
  const workspace = workspaceOverride ?? currentWorkspace
  return useMemo(
    () =>
      new AgentApiClient(
        {
          baseURL: `http://${host}:${port}`,
          headers: {
            Authorization: `Bearer ${apiKey}`
          }
        },
        undefined,
        workspace
      ),
    [host, port, apiKey, workspace]
  )
}
