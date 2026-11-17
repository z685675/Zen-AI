import { isZenManagedApiHost } from '@shared/config/zenProvider'
import { Agent, fetch as fetchIPv4 } from 'undici'

import type { ImageFetch } from './protocol'

type AddressStrategy = 'ipv4' | 'default'
const strategies = new WeakMap<Response, AddressStrategy>()
const fallbackDuration = 5 * 60 * 1000

export const studioDownloadAddressStrategy = (response: Response) => strategies.get(response)

/** Only result GETs use this transport; API writes and browser networking stay native. */
export function createStudioDownloadFetch(
  nativeFetch: ImageFetch,
  resolveProxy: (url: string) => Promise<string>
): ImageFetch {
  const fallbackUntil = new Map<string, number>()
  const native: ImageFetch = async (input, init) => {
    const response = await nativeFetch(input, init)
    strategies.set(response, 'default')
    return response
  }
  return async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? new URL(input) : undefined
    if (
      !url ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !isZenManagedApiHost(url.href) ||
      !/\/api\/image-studio\/assets\/[a-f0-9-]{32,64}$/.test(url.pathname) ||
      (init?.method || 'GET') !== 'GET' ||
      init?.body != null ||
      init?.redirect !== 'error' ||
      init?.credentials !== 'omit'
    ) {
      return native(input, init)
    }
    init.signal?.throwIfAborted()
    if ((fallbackUntil.get(url.origin) || 0) > Date.now()) return native(input, init)
    fallbackUntil.delete(url.origin)
    // The application's API session is authoritative. Never bypass an explicit
    // or system proxy, and keep the native path if proxy resolution is uncertain.
    let proxy: string
    try {
      proxy = await resolveProxy(url.href)
    } catch {
      return native(input, init)
    }
    init.signal?.throwIfAborted()
    if (proxy.trim() !== 'DIRECT') return native(input, init)

    const agent = new Agent({
      connect: { family: 4, timeout: 8000 },
      headersTimeout: 12000,
      bodyTimeout: 20000
    })
    const failed = () => fallbackUntil.set(url.origin, Date.now() + fallbackDuration)
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      init.signal?.removeEventListener('abort', aborted)
      void agent.destroy().catch(() => {})
    }
    const aborted = () => {
      failed()
      dispose()
    }
    init.signal?.addEventListener('abort', aborted, { once: true })
    try {
      // Resolve A records normally, retaining the URL hostname for Host, SNI and
      // certificate verification. No hardcoded CF/origin IP or global dispatcher.
      const response = await fetchIPv4(url.href, {
        method: 'GET',
        headers: Array.from(new Headers(init.headers).entries()),
        signal: init.signal,
        redirect: 'error',
        credentials: 'omit',
        dispatcher: agent
      })
      const reader = response.body?.getReader()
      const body = reader
        ? new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { done, value } = await reader.read()
                if (done) {
                  controller.close()
                  dispose()
                } else controller.enqueue(value)
              } catch (error) {
                // Let the existing download loop resume its validated checkpoint
                // using the native transport on its next attempt.
                failed()
                dispose()
                controller.error(error)
              }
            },
            cancel(reason) {
              dispose()
              return reader.cancel(reason).catch(() => {})
            }
          })
        : null
      const result = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries())
      })
      if (!reader) dispose()
      strategies.set(result, 'ipv4')
      return result
    } catch {
      failed()
      dispose()
      init.signal?.throwIfAborted()
      // GET only: falling back cannot submit another billable generation job.
      return native(input, init)
    }
  }
}
