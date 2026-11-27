import { lookup } from 'node:dns/promises'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createAssistantToolFailure } from '@shared/agents/toolFailure'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:os')
vi.unmock('node:path')
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '1.1.1.1' }]) }))
vi.mock('../assistantReadDocument', () => ({
  readAssistantDocument: vi.fn(async () => ({
    partial: true,
    status: 'partial',
    returned_chars: 100,
    next_cursor: 'cursor'
  }))
}))

import { PaperReadError, readPaper, searchLiterature } from '../assistantLiterature'
import { readAssistantDocument } from '../assistantReadDocument'

beforeEach(() => vi.mocked(readAssistantDocument).mockClear())
afterEach(() => vi.restoreAllMocks())

async function removePaperFixture(root: string) {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('zen-paper-test-')) {
    throw new Error('Unexpected fixture')
  }
  await fs.rm(root, { recursive: true, force: true })
}

describe('bounded literature acquisition', () => {
  it('batches discovery, deduplicates DOI aliases and separates missing abstracts from full text', async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: {
              items: [
                {
                  DOI: '10.1234/ABC',
                  title: ['A paper'],
                  abstract: '<jats:p>Actual abstract</jats:p>',
                  link: [{ URL: 'https://papers.example/full.pdf', 'content-type': 'application/pdf' }]
                },
                { DOI: '10.1234/abc', title: ['Alias'] },
                { DOI: '10.1234/def<2>', title: ['Metadata only'] }
              ]
            }
          })
        )
    )
    const result = await searchLiterature({ queries: ['composite fatigue', 'laminate vibration'] }, undefined, request)
    expect(request).toHaveBeenCalledTimes(2)
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]).toMatchObject({
      evidence_level: 'abstract',
      abstract: 'Actual abstract',
      content_links: [{ access_verified: false }]
    })
    expect(result.sources[1]).toMatchObject({ evidence_level: 'metadata', abstract: null })
    expect(result.sources[1].url).toBe('https://doi.org/10.1234/def%3C2%3E')
    expect(result).not.toHaveProperty('full_text')
  })
  it('does not turn an HTML access check into PDF evidence or disable certificates', async () => {
    await expect(
      readPaper(
        { url: 'https://papers.example/login' },
        '/unused',
        undefined,
        async () => new Response('<html>Login</html>')
      )
    ).rejects.toThrow('did not return a PDF')
    expect(readAssistantDocument).not.toHaveBeenCalled()
  })
  it('blocks private addresses including redirects', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never)
    const request = vi.fn()
    await expect(readPaper({ url: 'https://local.example/file.pdf' }, '/unused', undefined, request)).rejects.toThrow(
      'Private/local'
    )
    expect(request).not.toHaveBeenCalled()
    vi.mocked(lookup)
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }] as never)
      .mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }] as never)
    await expect(
      readPaper(
        { url: 'https://papers.example/redirect' },
        '/unused',
        undefined,
        async () => new Response('', { status: 302, headers: { location: 'https://internal.example/file.pdf' } })
      )
    ).rejects.toThrow('Private/local')
  })
  it('downloads once, preserves cursor identity, and returns bounded parsed text rather than binary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-paper-test-'))
    try {
      const request = vi.fn(async () => new Response('%PDF-1.7 fixture'))
      const args = { url: 'https://papers.example/core.pdf', max_pages: 2 }
      const first = await readPaper(args, root, undefined, request)
      const next = await readPaper({ ...args, cursor: 'cursor' }, root, undefined, request)
      expect(request).toHaveBeenCalledOnce()
      expect(first.evidence_level).toBe('full_text_excerpt')
      expect(first.measurement).toMatchObject({ outcome: 'completed', stage: 'complete', source: 'download' })
      expect(next.measurement).toMatchObject({ outcome: 'completed', source: 'cached' })
      expect(next.measurement.total_ms).toBeGreaterThanOrEqual(0)
      expect(next.next_cursor).toBe('cursor')
      expect(next.continuation).toContain('within a page')
      const calls = vi.mocked(readAssistantDocument).mock.calls
      expect(calls.at(-1)![0].file_path).toBe(calls.at(-2)![0].file_path)
    } finally {
      await removePaperFixture(root)
    }
  })
  it('reads a public PDF behind virtual DNS only after independent public verification', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-paper-test-'))
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: '198.18.0.233', family: 4 },
      { address: '2001:2::e2', family: 6 }
    ] as never)
    const request = vi.fn(async (target: string) => {
      const url = new URL(target)
      if (url.hostname !== 'cloudflare-dns.com') return new Response('%PDF-1.7 fixture')
      const type = Number(url.searchParams.get('type'))
      const name = url.searchParams.get('name')!
      return new Response(
        JSON.stringify({
          Status: 0,
          Question: [{ name, type }],
          Answer: type === 1 ? [{ name, type, data: '1.1.1.1' }] : []
        })
      )
    })
    try {
      const result = await readPaper({ url: 'https://public.example/virtual.pdf' }, root, undefined, request)
      expect(result.evidence_level).toBe('full_text_excerpt')
      expect(request).toHaveBeenCalledTimes(3)
    } finally {
      await removePaperFixture(root)
    }
  })

  it.each(['download', 'parse'] as const)(
    'reports a %s deadline as timeout, even when parsing says cancelled',
    async (stage) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-paper-test-'))
      const deadline = new AbortController()
      const caller = new AbortController()
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
        ms === 30000 ? deadline.signal : originalTimeout(ms)
      )
      let entered!: () => void
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const wait = (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              caller.abort()
              reject(new Error('Document read cancelled'))
            },
            { once: true }
          )
          entered()
        })
      if (stage === 'parse')
        vi.mocked(readAssistantDocument).mockImplementationOnce(async (_args, _resolve, signal) => wait(signal!))
      const request = vi.fn(async (_url: string, init: RequestInit) =>
        stage === 'download' ? wait(init.signal!) : new Response('%PDF-1.7 fixture')
      )
      try {
        const pending = readPaper({ url: `https://papers.example/${stage}.pdf` }, root, caller.signal, request).catch(
          (error) => error
        )
        await ready
        deadline.abort(new DOMException('Deadline elapsed', 'TimeoutError'))
        const error = await pending
        expect(error).toBeInstanceOf(PaperReadError)
        expect(error.measurement).toMatchObject({ stage, outcome: 'timeout', source: 'download' })
        for (const key of ['queue_ms', 'download_ms', 'parse_ms', 'total_ms'])
          expect(error.measurement[key]).toBeGreaterThanOrEqual(0)
        expect(error.message).toContain(`timed out during ${stage}`)
        expect(createAssistantToolFailure('read_paper', error)).toMatchObject({
          code: 'timeout',
          automatic_retry: false
        })
        expect(request).toHaveBeenCalledOnce()
      } finally {
        await removePaperFixture(root)
      }
    }
  )

  it('distinguishes caller cancellation and leaves subsequent reads available', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-paper-test-'))
    const cancel = new AbortController()
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const request = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
          entered()
        })
    )
    try {
      const pending = readPaper({ url: 'https://papers.example/cancel.pdf' }, root, cancel.signal, request).catch(
        (error) => error
      )
      await ready
      cancel.abort()
      const error = await pending
      expect(error.measurement).toMatchObject({ stage: 'download', outcome: 'cancelled' })
      expect(createAssistantToolFailure('read_paper', error).code).toBe('cancelled')
      const next = await readPaper(
        { url: 'https://papers.example/recover.pdf' },
        root,
        undefined,
        async () => new Response('%PDF-1.7 fixture')
      )
      expect(next.measurement.outcome).toBe('completed')
    } finally {
      await removePaperFixture(root)
    }
  })

  it('cancels a queued read without sending its request or disturbing the active reads', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-paper-test-'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived = 0
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = async () => {
      if (++arrived === 2) entered()
      await gate
      return { partial: true, status: 'partial' as const, returned_chars: 1, next_cursor: 'cursor' } as Awaited<
        ReturnType<typeof readAssistantDocument>
      >
    }
    vi.mocked(readAssistantDocument).mockImplementationOnce(blocked).mockImplementationOnce(blocked)
    const request = vi.fn(async () => new Response('%PDF-1.7 fixture'))
    const active = [1, 2].map((id) =>
      readPaper({ url: `https://papers.example/queue-${id}.pdf` }, root, undefined, request)
    )
    try {
      await ready
      const cancel = new AbortController()
      const pending = readPaper({ url: 'https://papers.example/queued.pdf' }, root, cancel.signal, request).catch(
        (error) => error
      )
      cancel.abort()
      const error = await pending
      expect(error.measurement).toMatchObject({
        stage: 'queue',
        outcome: 'cancelled',
        download_ms: 0,
        parse_ms: 0,
        source: 'not-started'
      })
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      release()
      await Promise.all(active)
      await removePaperFixture(root)
    }
  })

  it('preserves a source failure code while adding phase timings', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('read'), { code: 'ECONNRESET' })
    })
    const error = await readPaper({ url: 'https://papers.example/reset.pdf' }, '/unused', undefined, request).catch(
      (error) => error
    )
    expect(error.measurement).toMatchObject({ stage: 'download', outcome: 'failed' })
    expect(createAssistantToolFailure('read_paper', error).code).toBe('network')
    expect(request).toHaveBeenCalledOnce()
  })
})
