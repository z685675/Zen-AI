import { managedModelFetch } from '@renderer/aiCore/provider/modelTransport'
import type { Provider } from '@renderer/types'
import { isZenManagedApiHost } from '@shared/config/zenProvider'
import { type DiagnosticEvent, diagnosticKeyFingerprint } from '@shared/diagnostics'
import { discardResponseBody } from '@shared/modelTransport'

export type BackendDiagnosticCollection = {
  status: string
  evidence: Array<Record<string, unknown>>
  details?: unknown
}
class DiagnosticBudgetError extends Error {}

async function readBoundedResponse(response: Response, budget: { bytes: number }): Promise<unknown> {
  if (!response.body) throw new SyntaxError('Empty API diagnostic response')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      budget.bytes += next.value.byteLength
      if (bytes > 1024 * 1024 || budget.bytes > 6 * 1024 * 1024) {
        void reader.cancel().catch(() => undefined)
        throw new DiagnosticBudgetError('Diagnostic collection reached its bounded response budget')
      }
      text += decoder.decode(next.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally {
    reader.releaseLock()
  }
}

/** Export-only, read-only and bounded. Never make an extra model generation request. */
export async function collectBackendDiagnostic(
  operationId: string,
  provider: Provider | undefined,
  events: DiagnosticEvent[],
  baseFetch: typeof fetch = managedModelFetch(fetch)
): Promise<BackendDiagnosticCollection> {
  if (!provider?.apiHost || !provider.apiKey) return { status: 'provider-or-key-unavailable', evidence: [] }
  const observed = events.filter((item) => item.stage === 'transport' && item.event === 'headers-received')
  const lastRequest = [...events]
    .reverse()
    .find((item) => item.stage === 'transport' && item.event === 'request-started')
  const nativeConfig = [...events].reverse().find((item) => item.event === 'transport-config')
  const requestUrl = lastRequest?.details?.url ?? observed.at(-1)?.details?.url ?? nativeConfig?.details?.apiHost
  let endpoint: URL
  try {
    const current = new URL(provider.apiHost.replace(/#$/, ''))
    if (requestUrl && new URL(String(requestUrl)).origin !== current.origin)
      return { status: 'provider-address-changed', evidence: [] }
    if (
      !isZenManagedApiHost(current.href) &&
      provider.type !== 'new-api' &&
      !observed.some((item) => item.details?.gateway === true)
    )
      return { status: 'not-a-zen-api-compatible-provider', evidence: [] }
    endpoint = new URL(
      `${current.pathname.replace(/\/(?:v1|v1beta)\/?$/, '').replace(/\/$/, '')}/api/client/request-diagnostic`,
      current.origin
    )
  } catch {
    return { status: 'invalid-provider-address', evidence: [] }
  }

  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException('Diagnostic request timed out', 'TimeoutError')),
    5_000
  )
  const evidence: Array<Record<string, unknown>> = []
  const responses: Array<Record<string, unknown>> = []
  const requestIds = [
    ...new Set(observed.map((item) => item.details?.requestId).filter((id): id is string => typeof id === 'string'))
  ]
  // An operation ID also covers native SDK HTTP calls for which headers are hidden.
  const budget = { bytes: 0 }
  let expectedRequests = requestIds.length
  const usedFingerprints = [
    ...new Set(
      events.map((event) => event.details?.keyFingerprint).filter((value): value is string => typeof value === 'string')
    )
  ]
  const keys = [
    ...new Set(
      provider.apiKey
        .split(/[\n,]/)
        .map((key) => key.trim())
        .filter(Boolean)
    )
  ].slice(0, 16)
  const matchingKeys = usedFingerprints.length
    ? (await Promise.all(keys.map(async (key) => ({ key, fingerprint: await diagnosticKeyFingerprint(key) }))))
        .filter((entry) => entry.fingerprint && usedFingerprints.includes(entry.fingerprint))
        .map((entry) => entry.key)
    : keys.slice(0, 1)
  try {
    if (!matchingKeys.length) return { status: 'provider-key-changed-or-unavailable', evidence: [] }
    for (const key of matchingKeys.slice(0, 3)) {
      const query = async (requestId?: string) => {
        const url = new URL(endpoint)
        if (requestId) url.searchParams.set('request_id', requestId)
        else url.searchParams.set('operation_id', operationId)
        const response = await baseFetch(url, {
          signal: controller.signal,
          redirect: 'error',
          headers: { Authorization: `Bearer ${key}` }
        })
        if (!response.ok) {
          discardResponseBody(response)
          responses.push({ requestId, status: response.status })
          if (response.status === 404 || response.status === 401 || response.status === 403)
            throw Object.assign(new Error('Diagnostic endpoint unavailable'), {
              diagnosticStatus: response.status === 404 ? 'api-version-unsupported' : 'api-diagnostic-access-denied'
            })
          return
        }
        const payload = (await readBoundedResponse(response, budget)) as {
          success?: boolean
          source?: string
          available?: boolean
          omittedRequests?: number
          persistentStatus?: string
          evidence?: Array<Record<string, unknown>>
        }
        if (payload?.success !== true || !Array.isArray(payload.evidence))
          throw new SyntaxError('Invalid API diagnostic response')
        if (!requestId)
          expectedRequests = Math.max(
            expectedRequests,
            payload.evidence.length + Math.max(0, Number(payload.omittedRequests) || 0)
          )
        for (const entry of payload.evidence.slice(0, 32)) {
          if (
            entry &&
            typeof entry.requestId === 'string' &&
            !evidence.some((saved) => saved.requestId === entry.requestId) &&
            evidence.length < 128
          )
            evidence.push(entry)
        }
        responses.push({
          requestId,
          source: payload.source,
          available: payload.available,
          omittedRequests: payload.omittedRequests,
          persistentStatus: payload.persistentStatus
        })
      }
      await query()
      // Operation queries may return only 32 records. Fetch the missing IDs,
      // not merely the last six, with at most four read-only requests in flight.
      const missing = requestIds.filter((id) => !evidence.some((entry) => entry.requestId === id)).slice(0, 128)
      for (let offset = 0; offset < missing.length; offset += 4) {
        const batch = await Promise.allSettled(missing.slice(offset, offset + 4).map(query))
        const failed = batch.find((result) => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      }
    }
    const missingRequests = Math.max(0, expectedRequests - evidence.length)
    responses.unshift({
      source: 'collection-coverage',
      status: missingRequests ? 'partial' : 'complete',
      observedRequests: requestIds.length,
      collectedRequests: evidence.length,
      missingRequests
    })
    return {
      status: evidence.length ? (missingRequests ? 'partially-collected' : 'collected') : 'not-found-or-expired',
      evidence,
      details: responses
    }
  } catch (error) {
    return {
      status:
        error instanceof Error && 'diagnosticStatus' in error
          ? String(error.diagnosticStatus)
          : controller.signal.aborted
            ? 'timed-out'
            : error instanceof DiagnosticBudgetError
              ? 'collection-budget-reached'
              : error instanceof SyntaxError
                ? 'invalid-api-diagnostic-response'
                : 'network-unavailable',
      evidence,
      details: { responses, error: error instanceof Error ? error.message : String(error) }
    }
  } finally {
    clearTimeout(timer)
  }
}
