import { DEFAULT_DSH_AGENT_ID, DEFAULT_OPENCODE_AGENT_AVATAR, DEFAULT_OPENCODE_AGENT_NAME } from '@shared/config/agents'

import { agentService } from '../agents/services/AgentService'
import { provisionBuiltinAgent } from '../agents/services/builtin/BuiltinAgentProvisioner'
import { DEFAULT_ASSISTANT_DESCRIPTION, DEFAULT_ASSISTANT_INSTRUCTIONS } from '../agents/services/opencode/defaults'
import { assertDshPreviewUnlocked } from './access'

let initialization: Promise<string | null> | undefined

export async function ensureDshPreviewAgent(): Promise<string | null> {
  assertDshPreviewUnlocked()
  if (initialization) return initialization
  initialization = agentService
    .initBuiltinAgent({
      id: DEFAULT_DSH_AGENT_ID,
      builtinRole: 'dsh-preview',
      fallbackToAvailableModel: true,
      provisionWorkspace: async (workspace) => {
        const original = await provisionBuiltinAgent(workspace, 'fusion')
        return {
          ...original,
          name: DEFAULT_OPENCODE_AGENT_NAME,
          description: DEFAULT_ASSISTANT_DESCRIPTION,
          instructions: DEFAULT_ASSISTANT_INSTRUCTIONS,
          configuration: {
            ...original?.configuration,
            avatar: DEFAULT_OPENCODE_AGENT_AVATAR,
            assistant_engine: 'dsh',
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
