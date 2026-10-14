import {
  DEFAULT_OPENCODE_AGENT_AVATAR,
  DEFAULT_OPENCODE_AGENT_ID,
  DEFAULT_OPENCODE_AGENT_NAME
} from '@shared/config/agents'

import { agentService } from '../AgentService'
import { provisionBuiltinAgent } from '../builtin/BuiltinAgentProvisioner'

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
          description: 'Zen AI 智能助手，使用 OpenCode 执行任务、处理文件和操作浏览器。',
          instructions:
            'You are Zen AI New Assistant. Help the user finish tasks using the tools actually available in this session. Answer simple greetings directly. Do not claim access to disconnected search services, schedulers, IM or cross-conversation memory.',
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
