import { isZenManagedApiHost } from '@shared/config/zenProvider'

export function buildOpenCodeAuditHeaders(apiHost: string, clientId: string, version: string, platform: string) {
  return {
    'X-Zen-App-Version': version,
    'X-Zen-Platform': platform,
    ...(isZenManagedApiHost(apiHost) && clientId ? { 'X-Zen-Client-Id': clientId } : {})
  }
}
