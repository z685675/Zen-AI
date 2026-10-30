import {
  DEFAULT_OPENCODE_AGENT_AVATAR,
  DEFAULT_OPENCODE_AGENT_ID,
  DEFAULT_OPENCODE_AGENT_NAME
} from '@shared/config/agents'

import { agentService } from '../AgentService'
import { provisionBuiltinAgent } from '../builtin/BuiltinAgentProvisioner'
import { DEFAULT_ASSISTANT_DESCRIPTION, DEFAULT_ASSISTANT_INSTRUCTIONS } from './defaults'

let initialization: Promise<string | null> | undefined

export function ensureOpenCodeAgent(): Promise<string | null> {
  if (initialization) return initialization
  initialization = agentService
    .initBuiltinAgent({
      id: DEFAULT_OPENCODE_AGENT_ID,
      builtinRole: 'fusion',
      fallbackToAvailableModel: true,
      provisionWorkspace: async (workspace) => {
        const original = await provisionBuiltinAgent(workspace, 'fusion')
        return {
          ...original,
          name: DEFAULT_OPENCODE_AGENT_NAME,
          // Do not inherit the old agent's Exa/scheduler/Soul instructions.
          // The OpenCode service supplies its own connected-tool contract.
          description: DEFAULT_ASSISTANT_DESCRIPTION,
          instructions: DEFAULT_ASSISTANT_INSTRUCTIONS,
          configuration: {
            ...original?.configuration,
            avatar: DEFAULT_OPENCODE_AGENT_AVATAR,
            assistant_engine: 'opencode',
            permission_mode: 'default',
            soul_enabled: false,
            scheduler_enabled: false,
            heartbeat_enabled: false
          }
        }
      }
    })
    .finally(() => {
      initialization = undefined
    })
  return initialization
}
