import { lookup } from 'node:dns'
import type { LookupFunction } from 'node:net'

import { discardResponseBody } from '@shared/modelTransport'
import ipaddr from 'ipaddr.js'
import { Agent } from 'undici'

export const PUBLIC_WEB_PROTOCOLS = ['http:', 'https:']
export const isPublicAddress = (address: string) =>
  ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast'

export function webHostname(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '')
}

export function parsePublicWebUrl(value: string, protocols = PUBLIC_WEB_PROTOCOLS): URL {
  const url = new URL(value)
  if (!protocols.includes(url.protocol) || url.username || url.password)
    throw new Error('Only public web addresses without embedded credentials are supported')
  const hostname = webHostname(url)
  if (ipaddr.isValid(hostname) ? !isPublicAddress(hostname) : isLocalHostname(hostname))
    throw new Error('Private/local web addresses are not supported')
  return url
}

export function isLocalHostname(hostname: string): boolean {
  return (
    !hostname.includes('.') || /(?:^|\.)(?:localhost|localdomain|local|internal|lan|home|home\.arpa)$/.test(hostname)
  )
}

const lookupPublicAddress: LookupFunction = (hostname, options, callback) => {
  // This lookup supplies the actual socket addresses. Do not validate against
  // one answer and then let a second, unrestricted lookup choose the endpoint.
  lookup(hostname, { all: true, family: options.family, hints: options.hints }, (error, answers) => {
    if (error) return callback(error, '')
    if (!answers.length || answers.some(({ address }) => !isPublicAddress(address))) {
      return callback(Object.assign(new Error('Private/local web addresses are not supported'), { code: 'EACCES' }), '')
    }
    if (options.all) callback(null, answers)
    else callback(null, answers[0].address, answers[0].family)
  })
}

const publicAgent = new Agent({ connect: { lookup: lookupPublicAddress, timeout: 10_000 } })
const REDIRECTS = new Set([301, 302, 303, 307, 308])

export function fetchPublicHttpsResult(value: string | URL, signal?: AbortSignal | null): Promise<Response> {
  const url = parsePublicWebUrl(String(value), ['https:'])
  const options = { dispatcher: publicAgent, redirect: 'error', credentials: 'omit', signal } as const
  return fetch(url, options)
}

export async function fetchPublicWeb(
  input: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal
): Promise<Response> {
  let url = parsePublicWebUrl(input)
  const requestHeaders = new Headers(headers)
  for (const name of ['host', 'connection', 'proxy-authorization']) requestHeaders.delete(name)
  const options = {
    dispatcher: publicAgent,
    redirect: 'manual',
    credentials: 'omit',
    signal,
    headers: requestHeaders
  } as const

  for (let redirects = 0; ; redirects++) {
    const response = await fetch(url, options)
    if (!REDIRECTS.has(response.status)) return response
    discardResponseBody(response)
    const location = response.headers.get('location')
    if (!location || redirects === 3) throw new Error('Public web redirect limit reached')
    const next = parsePublicWebUrl(new URL(location, url).href)
    if (next.origin !== url.origin) {
      for (const name of Array.from(requestHeaders.keys())) {
        if (name !== 'accept' && name !== 'user-agent') requestHeaders.delete(name)
      }
    }
    url = next
  }
}
