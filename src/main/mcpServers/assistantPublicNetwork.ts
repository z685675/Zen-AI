import { lookup } from 'node:dns/promises'

import { net, session } from 'electron'
import ipaddr from 'ipaddr.js'

import { isLocalHostname, isPublicAddress, webHostname } from './publicWebNetwork'

export type PublicRequest = (url: string, init: RequestInit) => Promise<Response>
let network: Promise<Electron.Session> | undefined

/** Public reading follows the system network, independently of the model API proxy. */
export const fetchAssistantPublic: PublicRequest = async (url, init) => {
  network ??= (async () => {
    const isolated = session.fromPartition('zen-literature-public')
    await isolated.setProxy({ mode: 'system' })
    return isolated
  })().catch((error) => {
    network = undefined
    throw error
  })
  const isolated = await network
  init.signal?.throwIfAborted()
  if ((init.method && init.method !== 'GET') || init.body)
    throw new Error('Public source requests must be read-only GET')
  // Electron fetch rejects manual redirects instead of exposing the 30x response.
  // Capture net.request's redirect event without following it. The caller validates
  // each destination before starting a separate request (including DNS checks).
  return new Promise<Response>((resolve, reject) => {
    const accept = new Headers(init.headers).get('accept')
    const request = net.request({
      url,
      session: isolated,
      method: 'GET',
      headers: accept ? { Accept: accept } : {},
      credentials: 'omit',
      useSessionCookies: false,
      redirect: 'manual',
      bypassCustomProtocolHandlers: true
    })
    let settled = false
    let finished = false
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    const cleanup = () => init.signal?.removeEventListener('abort', abort)
    const fail = (error: unknown) => {
      if (finished) return
      finished = true
      cleanup()
      if (settled) body?.error(error)
      else reject(error)
    }
    const abort = () => {
      fail(init.signal?.reason ?? new Error('Public source request cancelled'))
      request.abort()
    }
    init.signal?.addEventListener('abort', abort, { once: true })
    request.on('error', fail)
    request.on('abort', () => fail(new Error('Public source request cancelled')))
    // In Electron 40 the writable request can emit close after end(), before
    // response/redirect. Only network error/abort or response end are terminal.
    request.on('redirect', (status, _method, destination) => {
      settled = finished = true
      cleanup()
      resolve(new Response(null, { status, headers: { location: destination } }))
      request.abort()
    })
    request.on('response', (response) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        // Chromium decodes response data; never expose stale compression/size or cookies.
        if (['content-encoding', 'content-length', 'set-cookie'].includes(name.toLowerCase())) continue
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller
        },
        cancel() {
          finished = true
          cleanup()
          request.abort()
        }
      })
      let bytes = 0
      // Electron IncomingMessage has no pause API. Bound even an unconsumed body;
      // individual readers enforce their smaller HTML/DNS/PDF limits as they read.
      response.on('end', () => {
        if (finished) return
        finished = true
        cleanup()
        body?.close()
      })
      response.on('error', fail)
      response.on('aborted', () => fail(new Error('Public source response interrupted')))
      response.on('data', (chunk) => {
        if (finished) return
        bytes += chunk.length
        if (bytes > 16 * 1024 * 1024) {
          fail(new Error('Source exceeds download limit'))
          request.abort()
        } else body?.enqueue(chunk)
      })
      settled = true
      resolve(
        new Response([204, 205, 304].includes(response.statusCode) ? null : stream, {
          status: response.statusCode,
          headers
        })
      )
    })
    request.end()
  })
}

export async function readPublicBytes(response: Response, limit: number) {
  if (!response.body) throw new Error('Empty source response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.length
      if (bytes > limit) throw new Error('Source exceeds download limit')
      chunks.push(next.value)
    }
    return Buffer.concat(chunks)
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const normalizedHost = (value: string) => value.toLowerCase().replace(/\.$/, '')
function fakeDnsAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false
  const parsed = ipaddr.process(address)
  // Benchmark ranges used by fake-IP DNS. Never accept them as literal targets.
  return parsed.kind() === 'ipv4'
    ? parsed.match(ipaddr.parseCIDR('198.18.0.0/15'))
    : parsed.match(ipaddr.parseCIDR('2001:2::/48'))
}

async function verifyPublicDns(hostname: string, signal: AbortSignal | undefined, request: PublicRequest) {
  const timeout = AbortSignal.timeout(8_000)
  const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const answers = await Promise.all(
    [1, 28].map(async (type) => {
      const endpoint = new URL('https://cloudflare-dns.com/dns-query')
      // Send only the hostname, never the source path/query, cookies or credentials.
      endpoint.searchParams.set('name', hostname)
      endpoint.searchParams.set('type', String(type))
      const response = await request(endpoint.href, {
        signal: boundedSignal,
        headers: { Accept: 'application/dns-json' }
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('Public DNS verification unavailable; do not bypass the address check')
      }
      const data = JSON.parse((await readPublicBytes(response, 32_768)).toString('utf8'))
      if (
        data.Status !== 0 ||
        data.TC === true ||
        !Array.isArray(data.Question) ||
        !data.Question.some(
          (q: { name?: unknown; type?: unknown }) =>
            typeof q.name === 'string' && normalizedHost(q.name) === hostname && q.type === type
        ) ||
        (data.Answer !== undefined && (!Array.isArray(data.Answer) || data.Answer.length > 128))
      )
        throw new Error('Public DNS verification failed; do not bypass the address check')
      const records: Array<{ name: string; type: number; data: string }> = data.Answer ?? []
      const names = new Set([hostname])
      // Accept addresses only from the queried name's CNAME chain, not unrelated records.
      for (let depth = 0; depth < 16; depth++) {
        const before = names.size
        for (const record of records) {
          if (record.type !== 5 || typeof record.name !== 'string' || !names.has(normalizedHost(record.name))) continue
          if (typeof record.data !== 'string' || isLocalHostname(normalizedHost(record.data)))
            throw new Error('Private/local source addresses are not supported')
          names.add(normalizedHost(record.data))
        }
        if (names.size === before) break
      }
      return records
        .filter((r) => [1, 28].includes(r.type) && typeof r.name === 'string' && names.has(normalizedHost(r.name)))
        .map((r) => r.data)
    })
  )
  const addresses = answers.flat()
  if (!addresses.length || addresses.some((address) => typeof address !== 'string' || !isPublicAddress(address)))
    throw new Error('Private/local or unverifiable source addresses are not supported')
}

export async function assertPublicSourceUrl(value: string, signal?: AbortSignal, request = fetchAssistantPublic) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new Error('Only public HTTPS source URLs are supported')
  const hostname = webHostname(url)
  if (ipaddr.isValid(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error('Private/local source addresses are not supported')
    return url
  }
  if (isLocalHostname(hostname)) throw new Error('Private/local source addresses are not supported')
  signal?.throwIfAborted()
  const addresses = await lookup(hostname, { all: true })
  await assertPublicDnsAnswers(
    hostname,
    addresses.map(({ address }) => address),
    signal,
    request
  )
  return url
}

export async function assertPublicDnsAnswers(
  hostname: string,
  addresses: string[],
  signal?: AbortSignal,
  request = fetchAssistantPublic
): Promise<void> {
  if (!addresses.length || addresses.some((address) => !isPublicAddress(address) && !fakeDnsAddress(address)))
    throw new Error('Private/local source addresses are not supported')
  if (addresses.some(fakeDnsAddress)) {
    // Virtual addresses need independent public DNS evidence before system proxy/TUN routing.
    await verifyPublicDns(hostname, signal, request)
  }
  signal?.throwIfAborted()
}

export async function requestPublicSource(
  url: string,
  signal: AbortSignal,
  accept: string,
  request = fetchAssistantPublic
) {
  let current = await assertPublicSourceUrl(url, signal, request)
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted()
    const response = await request(current.href, { signal, headers: { Accept: accept } })
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current.href }
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || redirects === 3) throw new Error('Source redirect limit reached')
    current = await assertPublicSourceUrl(new URL(location, current).href, signal, request)
  }
  throw new Error('Source redirect limit reached')
}
