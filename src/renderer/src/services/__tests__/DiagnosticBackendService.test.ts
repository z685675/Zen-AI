import type { Provider } from '@renderer/types'
import type { DiagnosticEvent } from '@shared/diagnostics'
import { describe, expect, it, vi } from 'vitest'

import { collectBackendDiagnostic } from '../DiagnosticBackendService'

const provider = {
  id: 'zen',
  type: 'new-api',
  apiHost: 'https://zenai.925636.xyz/v1',
  apiKey: 'fake-key',
  models: []
} as unknown as Provider

describe('read-only API diagnostic collection', () => {
  it('queries the configured gateway with the existing key, not a model endpoint', async () => {
    const calls: URL[] = []
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push(url)
      expect(url.pathname).toBe('/api/client/request-diagnostic')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fake-key')
      expect(init?.body).toBeUndefined()
      return new Response(
        JSON.stringify({
          success: true,
          available: true,
          evidence: [{ requestId: 'api-r', outcome: 'failed', failureStage: 'channel-upstream-response' }]
        })
      )
    }
    const result = await collectBackendDiagnostic('operation', provider, [], fetcher as typeof fetch)
    expect(result.status).toBe('collected')
    expect(calls[0].searchParams.get('operation_id')).toBe('operation')
    expect(JSON.stringify(result)).not.toContain('fake-key')
  })
  it('explicitly reports old API versions and missing records', async () => {
    expect(
      (await collectBackendDiagnostic('op', provider, [], async () => new Response('', { status: 404 }))).status
    ).toBe('api-version-unsupported')
    expect(
      (
        await collectBackendDiagnostic(
          'op',
          provider,
          [],
          async () => new Response(JSON.stringify({ success: true, evidence: [] }))
        )
      ).status
    ).toBe('not-found-or-expired')
  })
  it('does not send credentials to a changed provider address', async () => {
    const events: DiagnosticEvent[] = [
      {
        at: 'now',
        stage: 'transport',
        event: 'headers-received',
        details: { url: 'https://other.example/v1/chat/completions' }
      }
    ]
    let called = false
    const result = await collectBackendDiagnostic('op', provider, events, async () => {
      called = true
      return new Response('{}')
    })
    expect(called).toBe(false)
    expect(result.status).toBe('provider-address-changed')
  })
  it('reports network failure without inventing backend evidence', async () => {
    const result = await collectBackendDiagnostic('op', provider, [], async () => {
      throw new Error('offline')
    })
    expect(result).toMatchObject({ status: 'network-unavailable', evidence: [] })
  })
  it('does not confuse a checkpoint on another provider with the final completion provider', async () => {
    const events: DiagnosticEvent[] = [
      { at: '1', stage: 'transport', event: 'headers-received', details: { url: 'https://other.example/v1/messages' } },
      {
        at: '2',
        stage: 'transport',
        event: 'request-started',
        details: { url: provider.apiHost + '/chat/completions' }
      }
    ]
    const result = await collectBackendDiagnostic(
      'op',
      provider,
      events,
      async () => new Response(JSON.stringify({ success: true, evidence: [{ requestId: 'final-request' }] }))
    )
    expect(result.status).toBe('collected')
  })
  it('reports an invalid HTML response separately from connectivity failure', async () => {
    const result = await collectBackendDiagnostic('op', provider, [], async () => new Response('<html>proxy</html>'))
    expect(result.status).toBe('invalid-api-diagnostic-response')
  })
  it('bounds the entire collection at five seconds and reports a timeout', async () => {
    vi.useFakeTimers()
    try {
      const pending = collectBackendDiagnostic(
        'op',
        provider,
        [],
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('abort')), { once: true })
          })
      )
      await vi.advanceTimersByTimeAsync(5000)
      expect(await pending).toMatchObject({ status: 'timed-out', evidence: [] })
    } finally {
      vi.useRealTimers()
    }
  })
})
