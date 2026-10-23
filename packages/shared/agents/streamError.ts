import { sanitizeDiagnostic } from '../diagnostics'

/** Preserve native failure evidence without reintroducing unsanitized message/stack fields. */
export function serializeAgentStreamError(
  error: unknown,
  fallbackMessage = 'Stream error'
): Record<string, unknown> & { message: string } {
  const value = sanitizeDiagnostic(error)
  if (typeof value === 'string') return { message: value }
  const details = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    ...details,
    message: typeof details.message === 'string' && details.message ? details.message : fallbackMessage
  }
}
