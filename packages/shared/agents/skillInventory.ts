export type SessionSkillInventory = {
  observedAt: string
  nativeStatus: 'observed' | 'not-running' | 'starting' | 'unavailable'
  refreshRequired: boolean
  skills: Array<{
    name: string
    path: string
    source: 'installed' | 'workspace' | 'native'
    installed: boolean
    enabled: boolean
    discovered: boolean | null
  }>
}
