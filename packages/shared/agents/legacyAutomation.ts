/** Product boundary: legacy integrations stay closed until separately implemented for OpenCode. */
export const isLegacyAutomationEnabled = (): boolean => false

export const LEGACY_AUTOMATION_DISABLED_CODE = 'legacy_automation_disabled'
export const LEGACY_AUTOMATION_DISABLED_MESSAGE =
  '弃用助手的微信等外部接入和定时任务已停用。已有配置与记录保留，待新版助手支持后再开放。'

export function assertLegacyAutomationEnabled(): void {
  if (!isLegacyAutomationEnabled()) {
    throw Object.assign(new Error(LEGACY_AUTOMATION_DISABLED_MESSAGE), { code: LEGACY_AUTOMATION_DISABLED_CODE })
  }
}
