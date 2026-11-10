/** Recognize native permission rejection, including historical wrapped errors.
 * Never infer a user decision from a provider's generic 403/permission error. */
export function isAgentPermissionRejection(error: unknown): boolean {
  let value = error
  for (let depth = 0; depth < 4; depth++) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        return false
      }
    }
    if (!value || typeof value !== 'object') return false
    const item = value as {
      code?: unknown
      name?: unknown
      message?: unknown
      data?: { message?: unknown }
      cause?: unknown
    }
    if (item.code === 'agent_permission_denied') return true
    const message = item.data?.message ?? item.message
    if (
      item.name === 'UnknownError' &&
      typeof message === 'string' &&
      /^The user rejected permission to use this specific tool call(?:\.| with the following feedback:)/.test(message)
    )
      return true
    value = item.cause
  }
  return false
}
