import type { AgentBase, AgentConfiguration } from '@renderer/types'
import type { PermissionModeCard } from '@renderer/types/agent'

// base agent config. no default config for now.
const DEFAULT_AGENT_CONFIG: Omit<AgentBase, 'model'> = {
  accessible_paths: []
} as const

// no default config for now.
export const DEFAULT_CLAUDE_CODE_CONFIG: Omit<AgentBase, 'model'> = {
  ...DEFAULT_AGENT_CONFIG
} as const

export const DEFAULT_CHERRY_CLAW_CONFIG: Omit<AgentBase, 'model'> & { configuration: AgentConfiguration } = {
  ...DEFAULT_AGENT_CONFIG,
  configuration: {
    permission_mode: 'plan',
    max_turns: 100,
    env_vars: {},
    soul_enabled: true,
    scheduler_enabled: false,
    scheduler_type: 'interval',
    heartbeat_enabled: true,
    heartbeat_interval: 30
  }
} as const

export const permissionModeCards: PermissionModeCard[] = [
  {
    mode: 'plan',
    titleKey: 'agent.settings.tooling.permissionMode.plan.title',
    titleFallback: 'Plan',
    descriptionKey: 'agent.settings.tooling.permissionMode.plan.description',
    descriptionFallback:
      '分析问题、读取已授权资料并制定计划，不修改用户文件或执行任务。需要实际操作时，请切换到 Build。'
  },
  {
    mode: 'acceptEdits',
    titleKey: 'agent.settings.tooling.permissionMode.acceptEdits.title',
    titleFallback: 'Build',
    descriptionKey: 'agent.settings.tooling.permissionMode.acceptEdits.description',
    descriptionFallback: '连续完成已授权的任务，普通操作无需逐项批准。覆盖原文件、删除文件或超出授权范围时，仍需确认。'
  }
]
