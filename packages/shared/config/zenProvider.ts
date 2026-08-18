const ZEN_MANAGED_ROOT_DOMAIN = '925636.xyz'

export const isZenManagedApiHost = (input?: string): boolean => {
  if (!input?.trim()) return false

  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`)
    const hostname = url.hostname.toLowerCase()
    return hostname === ZEN_MANAGED_ROOT_DOMAIN || hostname.endsWith(`.${ZEN_MANAGED_ROOT_DOMAIN}`)
  } catch {
    return false
  }
}
