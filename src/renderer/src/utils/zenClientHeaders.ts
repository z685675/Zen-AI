import { uuid } from '@renderer/utils'

const CLIENT_ID_KEY = 'zen_client_id'
const APP_VERSION_KEY = 'zen_app_version'
const PLATFORM_KEY = 'zen_platform'

type ZenClientInfo = {
  clientId?: string
  version?: string
  platform?: string
  arch?: string
  hardwareArch?: string
}

function getStoredClientId(): string {
  const existing = localStorage.getItem(CLIENT_ID_KEY)
  if (existing) {
    return existing
  }

  const clientId = uuid()
  localStorage.setItem(CLIENT_ID_KEY, clientId)
  return clientId
}

function buildZenPlatform(info: ZenClientInfo): string | undefined {
  const platform = info.platform
  const arch = info.hardwareArch || info.arch

  if (platform === 'darwin') {
    if (arch === 'arm64') return 'macOS Apple Silicon'
    if (arch === 'x64') return 'macOS Intel'
    return arch ? `macOS ${arch}` : 'macOS'
  }

  if (platform === 'win32') {
    return arch ? `Windows ${arch}` : 'Windows'
  }

  if (platform === 'linux') {
    return arch ? `Linux ${arch}` : 'Linux'
  }

  if (platform && arch) {
    return `${platform} ${arch}`
  }

  return undefined
}

export function cacheZenClientInfo(info: ZenClientInfo | undefined) {
  if (!info) {
    return
  }
  if (info.clientId) {
    localStorage.setItem(CLIENT_ID_KEY, info.clientId)
  }
  if (info.version) {
    localStorage.setItem(APP_VERSION_KEY, info.version)
  }
  const platform = buildZenPlatform(info)
  if (platform) {
    localStorage.setItem(PLATFORM_KEY, platform)
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
    'X-Zen-Platform': localStorage.getItem(PLATFORM_KEY) || navigator.platform || 'unknown'
  }

  const version = localStorage.getItem(APP_VERSION_KEY)
  if (version) {
    headers['X-Zen-App-Version'] = version
  }

  return headers
}
