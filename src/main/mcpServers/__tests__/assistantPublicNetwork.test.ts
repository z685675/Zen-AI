import { lookup } from 'node:dns/promises'
import { EventEmitter } from 'node:events'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ request: vi.fn(), setProxy: vi.fn(), fromPartition: vi.fn() }))
vi.mock('electron', () => ({ net: { request: network.request }, session: { fromPartition: network.fromPartition } }))
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

import { assertPublicSourceUrl, fetchAssistantPublic, requestPublicSource } from '../assistantPublicNetwork'

const dnsAnswer = (url: string, addresses = ['1.1.1.1']) => {
  const query = new URL(url)
  const type = Number(query.searchParams.get('type'))
  const name = query.searchParams.get('name')!
  return new Response(
    JSON.stringify({
      Status: 0,
      Question: [{ name, type }],
      Answer: type === 1 ? addresses.map((data) => ({ name, type, data })) : []
    })
  )
}

beforeEach(() => {
  vi.mocked(lookup)
    .mockReset()
    .mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as never)
})

describe('public source network boundary', () => {
  it('uses an isolated system-network session and prevents cookie/redirect inheritance', async () => {
    const isolated = { setProxy: network.setProxy }
    network.fromPartition.mockReturnValue(isolated)
    const request = Object.assign(new EventEmitter(), { end: vi.fn(), abort: vi.fn() })
    network.request.mockReturnValue(request)
    const pending = fetchAssistantPublic('https://source.example/', {
      credentials: 'include',
      redirect: 'follow',
      headers: { Accept: 'text/html', Cookie: 'private', Authorization: 'secret' }
    })
    await vi.waitFor(() => expect(request.end).toHaveBeenCalledOnce())
    request.emit('redirect', 302, 'GET', 'https://other.example/', {})
    const response = await pending
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://other.example/')
    expect(network.setProxy).toHaveBeenCalledWith({ mode: 'system' })
    expect(network.request).toHaveBeenCalledWith({
      url: 'https://source.example/',
      session: isolated,
      method: 'GET',
      headers: { Accept: 'text/html' },
      credentials: 'omit',
      useSessionCookies: false,
      redirect: 'manual',
      bypassCustomProtocolHandlers: true
    })
    expect(request.abort).toHaveBeenCalledOnce()
    // Electron emits an expected cancellation after the redirect was captured.
    request.emit('error', new Error('Redirect was cancelled'))
  })

  it.each(['127.0.0.1', '10.1.2.3', '192.168.2.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:192.168.1.1'])(
    'rejects real private DNS answer %s without making an external verification request',
    async (address) => {
      vi.mocked(lookup).mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }] as never)
      const request = vi.fn()
      await expect(assertPublicSourceUrl('https://papers.example/paper.pdf', undefined, request)).rejects.toThrow(
        'Private/local'
      )
      expect(request).not.toHaveBeenCalled()
    }
  )

  it.each([
    'https://198.18.0.233/p.pdf',
    'https://[2001:2::e2]/p.pdf',
    'https://127.1/p.pdf',
    'https://localhost./p',
    'https://service.local/p',
    'https://service.home.arpa/p',
    'http://papers.example/p',
    'https://user:secret@papers.example/p',
    'https://papers.example:8443/p'
  ])('rejects literal virtual/local or unsupported target %s before DNS', async (url) => {
    const request = vi.fn()
    await expect(assertPublicSourceUrl(url, undefined, request)).rejects.toThrow()
    expect(lookup).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['198.18.0.233', '198.19.255.254', '2001:2::e2'])(
    'verifies both public DNS families for virtual address %s without sending source parameters',
    async (address) => {
      vi.mocked(lookup).mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }] as never)
      const request = vi.fn(async (url: string) => dnsAnswer(url))
      const url = await assertPublicSourceUrl(
        'https://papers.example/core.pdf?private=not-sent-to-dns',
        undefined,
        request
      )
      expect(url.hostname).toBe('papers.example')
      expect(request).toHaveBeenCalledTimes(2)
      for (const [target] of request.mock.calls) {
        expect(new URL(target).hostname).toBe('cloudflare-dns.com')
        expect(new URL(target).searchParams.get('name')).toBe('papers.example')
        expect(target).not.toContain('core.pdf')
        expect(target).not.toContain('private')
      }
    }
  )

  it('does not permit a mixed virtual/private local answer', async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: '198.18.0.1', family: 4 },
      { address: '10.0.0.1', family: 4 }
    ] as never)
    const request = vi.fn()
    await expect(assertPublicSourceUrl('https://papers.example/', undefined, request)).rejects.toThrow('Private/local')
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['10.0.0.1', '198.18.1.1', '127.0.0.1'])('rejects nonpublic verification answer %s', async (address) => {
    vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.1', family: 4 }] as never)
    await expect(
      assertPublicSourceUrl('https://papers.example/', undefined, async (url) => dnsAnswer(url, [address]))
    ).rejects.toThrow('Private/local')
  })

  it('fails closed when verification is unavailable, malformed, mismatched or truncated', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.1', family: 4 }] as never)
    for (const response of [
      () => new Response('', { status: 403 }),
      () => new Response('not json'),
      () => new Response(JSON.stringify({ Status: 2 })),
      () => new Response(JSON.stringify({ Status: 0, Question: [{ name: 'other.example', type: 1 }], Answer: [] })),
      () => new Response(JSON.stringify({ Status: 0, TC: true, Question: [{ name: 'papers.example', type: 1 }] })),
      () => new Response(' '.repeat(40_000))
    ]) {
      await expect(
        assertPublicSourceUrl('https://papers.example/', undefined, async () => response())
      ).rejects.toThrow()
    }
  })

  it('rejects private CNAME chains and does not accept unrelated public answers', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.1', family: 4 }] as never)
    const request = async (url: string) => {
      const type = Number(new URL(url).searchParams.get('type'))
      return new Response(
        JSON.stringify({
          Status: 0,
          Question: [{ name: 'papers.example', type }],
          Answer: [
            { name: 'unrelated.example', type: 1, data: '1.1.1.1' },
            { name: 'papers.example', type: 5, data: 'target.example' },
            { name: 'target.example', type: 1, data: '192.168.1.1' }
          ]
        })
      )
    }
    await expect(assertPublicSourceUrl('https://papers.example/', undefined, request)).rejects.toThrow('Private/local')
  })

  it('checks every redirect and never fetches the private destination', async () => {
    vi.mocked(lookup)
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }] as never)
      .mockResolvedValueOnce([{ address: '192.168.0.1', family: 4 }] as never)
    const request = vi.fn(
      async () => new Response('', { status: 302, headers: { location: 'https://internal.example/p.pdf' } })
    )
    await expect(
      requestPublicSource('https://papers.example/p.pdf', new AbortController().signal, 'application/pdf', request)
    ).rejects.toThrow('Private/local')
    expect(request).toHaveBeenCalledOnce()
  })
})
