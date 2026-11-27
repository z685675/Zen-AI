import type { LookupFunction } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

const { dnsLookup, connector } = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  connector: vi.fn<(lookup: LookupFunction) => void>()
}))
vi.mock('node:dns', () => ({ lookup: dnsLookup }))
vi.mock('undici', () => ({
  Agent: class {
    constructor({ connect }: { connect: { lookup: LookupFunction } }) {
      connector(connect.lookup)
    }
  }
}))

import { Fetcher } from '../fetch'
import { fetchPublicWeb, parsePublicWebUrl } from '../publicWebNetwork'

afterEach(() => vi.unstubAllGlobals())

describe('Fetch MCP public transport', () => {
  it.each(['file:///example.txt', 'http://localhost/', 'https://server.local/', 'https://user@public.example/'])(
    'rejects non-web or local destinations before making a request (%s)',
    async (url) => {
      const send = vi.fn()
      vi.stubGlobal('fetch', send)
      await expect(fetchPublicWeb(url, undefined, new AbortController().signal)).rejects.toThrow()
      expect(send).not.toHaveBeenCalled()
    }
  )

  it('preserves UTF-8 JSON decoding and the default browser User-Agent', async () => {
    const send = vi.fn().mockResolvedValue(new Response('\uFEFF{"ok":true}'))
    vi.stubGlobal('fetch', send)
    const result = await Fetcher.json({ url: 'https://public.example/' })
    expect(result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }], isError: false })
    expect(send.mock.calls[0][1].headers.get('user-agent')).toContain('Chrome/120.0.0.0')
  })

  it('accepts public HTTP and HTTPS addresses', () => {
    expect(parsePublicWebUrl('http://public.example/page').href).toBe('http://public.example/page')
    expect(parsePublicWebUrl('https://public.example/page').href).toBe('https://public.example/page')
  })

  it('filters the DNS answers used by the socket connector', () => {
    const lookup = connector.mock.calls[0][0]
    const result = vi.fn()
    dnsLookup.mockImplementationOnce((_host, _options, done) => done(null, [{ address: '93.184.216.34', family: 4 }]))
    lookup('public.example', { all: true }, result)
    expect(result).toHaveBeenLastCalledWith(null, [{ address: '93.184.216.34', family: 4 }])

    dnsLookup.mockImplementationOnce((_host, _options, done) =>
      done(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 }
      ])
    )
    lookup('public.example', { all: true }, result)
    expect(result).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'EACCES' }), '')
  })

  it('enforces the public policy at each redirect', async () => {
    const send = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://localhost/' } }))
    vi.stubGlobal('fetch', send)
    await expect(fetchPublicWeb('https://public.example/', undefined, new AbortController().signal)).rejects.toThrow(
      'Private/local'
    )
    expect(send).toHaveBeenCalledOnce()
  })

  it('clears caller credentials on cross-origin redirects', async () => {
    const sent: Array<{ origin: string; headers: Headers }> = []
    const send = vi.fn(async (url: URL, options: RequestInit) => {
      sent.push({ origin: url.origin, headers: new Headers(options.headers) })
      return sent.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://next.example/' } })
        : new Response('ok')
    })
    vi.stubGlobal('fetch', send)
    await fetchPublicWeb(
      'https://public.example/',
      { Authorization: 'Bearer fixture', 'X-API-Key': 'fixture', Accept: 'text/html' },
      new AbortController().signal
    )
    expect(sent).toHaveLength(2)
    expect(sent[0].headers.has('authorization')).toBe(true)
    expect(sent[1].headers.has('authorization')).toBe(false)
    expect(sent[1].headers.has('x-api-key')).toBe(false)
    expect(sent[1].headers.get('accept')).toBe('text/html')
    expect(send.mock.calls[0][1]).toMatchObject({ redirect: 'manual', dispatcher: expect.anything() })
  })
})
