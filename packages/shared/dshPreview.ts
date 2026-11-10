export const DSH_PREVIEW_VERSION = '0.2.2-alpha.3'

export type AgentWorkspace = 'legacy' | 'opencode' | 'dsh'

export const DSH_PREVIEW_IPC = {
  status: 'dsh-preview:status',
  unlock: 'dsh-preview:unlock',
  lock: 'dsh-preview:lock',
  prepare: 'dsh-preview:prepare',
  changed: 'dsh-preview:changed'
} as const

export type DshPreviewStatus = {
  unlocked: boolean
  version: string
  state: 'not-installed' | 'preparing' | 'ready' | 'error'
  progress?: string
  error?: string
}
