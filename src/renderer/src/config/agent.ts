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
    titleFallback: '计划',
    descriptionKey: 'agent.settings.tooling.permissionMode.plan.description',
    descriptionFallback: '先帮你分析问题、整理思路和列步骤，不会直接改文件，也不会执行命令。'
  },
  {
    mode: 'acceptEdits',
    titleKey: 'agent.settings.tooling.permissionMode.acceptEdits.title',
    titleFallback: '执行',
    descriptionKey: 'agent.settings.tooling.permissionMode.acceptEdits.description',
    descriptionFallback: '可以直接帮你改内容、执行任务，但遇到关键操作时会先确认。'
  },
  {
    mode: 'bypassPermissions',
    titleKey: 'agent.settings.tooling.permissionMode.bypassPermissions.title',
    titleFallback: '全自动',
    descriptionKey: 'agent.settings.tooling.permissionMode.bypassPermissions.description',
    descriptionFallback: '会尽量自己把任务连续做完，修改文件和执行命令通常不再逐项确认。',
    caution: true
  }
]
