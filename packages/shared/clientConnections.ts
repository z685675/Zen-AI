export const CLIENT_CONNECTION_ORIGIN = 'https://zenai.925636.xyz'
export const CLIENT_CONNECTION_PATH = '/api/client/connections'
export const CLIENT_CONNECTION_HEALTH = '/api/client/connection-health'

export interface ClientConnectionPolicy {
  schemaVersion: 1
  version: number
  mode: 'auto' | 'cloudflare'
  directOrigin: string
  fallbackOrigin: typeof CLIENT_CONNECTION_ORIGIN
  deploymentId: string
  updatedAt: string
}

export function isPublicIPv4Origin(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.origin !== value || url.protocol !== 'https:' || url.port) return false
    const parts = url.hostname.split('.').map(Number)
    if (parts.length !== 4 || !parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return false
    const [a, b, c] = parts
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  } catch {
    return false
  }
}

export function isClientConnectionPolicy(value: unknown): value is ClientConnectionPolicy {
  if (!value || typeof value !== 'object') return false
  const p = value as ClientConnectionPolicy
  return (
    p.schemaVersion === 1 &&
    Number.isSafeInteger(p.version) &&
    p.version > 0 &&
    (p.mode === 'auto' || p.mode === 'cloudflare') &&
    p.fallbackOrigin === CLIENT_CONNECTION_ORIGIN &&
    (isPublicIPv4Origin(p.directOrigin) || (p.mode === 'cloudflare' && p.directOrigin === '')) &&
    typeof p.deploymentId === 'string' &&
    /^[a-f0-9]{32}$/i.test(p.deploymentId) &&
    typeof p.updatedAt === 'string' &&
    Number.isFinite(Date.parse(p.updatedAt))
  )
}

/** Only the owned API origin is eligible. Downloads and browser websites are excluded. */
export function isRoutableApiRequest(value: string, method = 'GET'): boolean {
  try {
    const u = new URL(value)
    if (u.origin !== CLIENT_CONNECTION_ORIGIN || u.username || u.password || u.hash) return false
    const verb = method.toUpperCase()
    if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(verb)) return false
    if (
      /^\/api\/image-studio\/(?:bootstrap|models|jobs(?:\/(?:by-submission\/)?[a-zA-Z0-9_-]+)?|assets(?:\/[a-f0-9]+)?)\/?$/.test(
        u.pathname
      )
    )
      return true
    if (/^\/api\/usage\/token\/(?:statistics|model-daily(?:\/turn(?:\/state)?)?)\/?$/.test(u.pathname))
      return ['GET', 'HEAD', 'POST'].includes(verb)
    if (
      [
        '/api/status',
        '/api/client/models',
        '/api/client/model-performance',
        '/api/client/model-policy',
        '/api/client/model-capacity-catalog',
        '/api/client/request-diagnostic'
      ].includes(u.pathname)
    )
      return ['GET', 'HEAD'].includes(verb)
    return (
      ['GET', 'HEAD', 'POST'].includes(verb) &&
      /^\/(?:v1\/(?:chat\/completions|completions|responses(?:\/compact)?|messages(?:\/count_tokens)?|models(?:\/[^/]+)?|images\/(?:generations|edits))|v1beta\/models(?:\/[^/]+)?)\/?$/.test(
        u.pathname
      )
    )
  } catch {
    return false
  }
}
