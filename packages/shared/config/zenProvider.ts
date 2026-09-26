const ZEN_MANAGED_ROOT_DOMAIN = '925636.xyz'
const ZEN_CONTEXT_COMPACTION_HOST = 'zenai.925636.xyz'

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

/**
 * Context checkpoints are an auxiliary, centrally managed service. They must
 * never silently fall back to a user's local/test provider or to another
 * provider hosted under the managed root domain.
 */
export const isZenContextCompactionApiHost = (input?: string): boolean => {
  if (!input?.trim()) return false

  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`)
    return url.hostname.toLowerCase() === ZEN_CONTEXT_COMPACTION_HOST
  } catch {
    return false
  }
}
