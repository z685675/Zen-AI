import type { SerializedError } from '@renderer/types/error'

/** Inspect only structured error fields, never request bodies or credentials. */
export function connectionErrorText(error: unknown): string {
  const seen = new Set<object>()
  const collect = (value: unknown, depth: number): string[] => {
    if (depth > 5 || value == null) return []
    if (typeof value === 'string') {
      if (value.length < 16_384 && value.trim().startsWith('{')) {
        try {
          return collect(JSON.parse(value), depth + 1)
        } catch {
          /* Plain error text. */
        }
      }
      return [value.slice(0, 16_384)]
    }
    if (typeof value !== 'object' || seen.has(value)) return []
    seen.add(value)
    const data = value as Record<string, unknown>
    return ['name', 'message', 'code', 'cause', 'error', 'data'].flatMap((key) => collect(data[key], depth + 1))
  }
  return collect(error, 0).join('\n').toLowerCase()
}

export function getConnectionFailure(error?: SerializedError) {
  const evidence = error?.zenTransportFailure as Record<string, unknown> | undefined
  const receivedResponse = evidence?.receivedResponse
  const text = connectionErrorText(evidence?.error ?? error)
  // Real upstream HTTP errors remain upstream errors, even if their body says "timeout".
  const httpStatus = evidence?.status ?? error?.statusCode ?? error?.status
  if (receivedResponse !== false && Number(httpStatus) >= 400) return undefined
  const kind = /enotfound|eai_again|getaddrinfo/.test(text)
    ? 'dns'
    : /certificate|self.signed|depth_zero_self_signed_cert|cert_has_expired|cert_altname|unable_to_verify_leaf_signature|unable_to_get_issuer_cert/.test(
          text
        )
      ? 'certificate'
      : /und_err_connect_timeout|connecttimeouterror|connection timed out|connect timeout/.test(text)
        ? 'timeout'
        : /econnrefused|before secure tls connection was established/.test(text)
          ? 'connect'
          : /failed to fetch|fetch failed|networkerror/.test(text)
            ? 'unknown'
            : undefined
  if (!kind) return undefined
  // Once response headers have arrived, a body failure is a stream interruption.
  if (receivedResponse === true) return { kind: 'stream' as const, beforeHttp: false }
  return { kind, beforeHttp: kind !== 'unknown' } as const
}
