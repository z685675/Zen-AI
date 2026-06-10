import { uuid } from '@renderer/utils'

const CLIENT_ID_KEY = 'zen_client_id'
const APP_VERSION_KEY = 'zen_app_version'

function getStoredClientId(): string {
  const existing = localStorage.getItem(CLIENT_ID_KEY)
  if (existing) {
    return existing
  }

  const clientId = uuid()
  localStorage.setItem(CLIENT_ID_KEY, clientId)
  return clientId
}

export function cacheZenClientInfo(info: { clientId?: string; version?: string } | undefined) {
  if (!info) {
    return
  }
  if (info.clientId) {
    localStorage.setItem(CLIENT_ID_KEY, info.clientId)
  }
  if (info.version) {
    localStorage.setItem(APP_VERSION_KEY, info.version)
  }
}

export function isZenManagedApiHost(input?: string): boolean {
  if (!input) {
    return false
  }

  try {
    const { hostname } = new URL(input)
    return hostname === '925636.xyz' || hostname.endsWith('.925636.xyz')
  } catch {
    return false
  }
}

export function getZenClientHeaders(apiHost?: string): Record<string, string> {
  if (!isZenManagedApiHost(apiHost)) {
    return {}
  }

  const headers: Record<string, string> = {
    'X-Zen-Client-Id': getStoredClientId(),
    'X-Zen-Platform': navigator.platform || 'unknown'
  }

  const version = localStorage.getItem(APP_VERSION_KEY)
  if (version) {
    headers['X-Zen-App-Version'] = version
  }

  return headers
}
