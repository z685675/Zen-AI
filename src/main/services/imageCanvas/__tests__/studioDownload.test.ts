import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')

import { downloadStudioAsset } from '../studioDownload'
import { StudioDownloadCache } from '../StudioDownloadCache'

const id = 'a'.repeat(64)
const root = 'https://zenai.925636.xyz/api/image-studio'
const auth = new Headers({ Authorization: 'Bearer never-log-or-save-this-key' })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const headers = (text: string) => ({
  'Content-Length': String(text.length),
  ETag: '"image-v1"',
  'X-Image-SHA256': hash(text)
})
const directories: string[] = []
const cache = () => {
  const directory = mkdtempSync(join(tmpdir(), 'zen-image-download-test-'))
  directories.push(directory)
  return { directory, store: new StudioDownloadCache(directory).forScope('1'.repeat(64)) }
}
afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('image result downloads', () => {
  it('continues a healthy download beyond 60 seconds and reports byte progress', async () => {
    vi.useFakeTimers()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let sent = 0
        const timer = setInterval(() => {
          controller.enqueue(new TextEncoder().encode('a'))
          if (++sent === 4) {
            clearInterval(timer)
            controller.close()
          }
        }, 20000)
      }
    })
    const request = vi.fn().mockResolvedValue(new Response(stream, { headers: headers('aaaa') }))
    const progress = vi.fn()
    const result = downloadStudioAsset(request, root, id, auth, progress)
    await vi.advanceTimersByTimeAsync(80000)
    expect(await result).toEqual(Buffer.from('aaaa'))
    expect(request).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ receivedBytes: 3, totalBytes: 4, state: 'downloading' })
    )
    expect(progress.mock.lastCall?.[0]).toMatchObject({ state: 'completed', receivedBytes: 4 })
    expect(request.mock.calls[0][1].signal.aborted).toBe(false)
  })

  it('resumes an interrupted HTTP 200 at the validated byte offset', async () => {
    vi.useFakeTimers()
    const { store } = cache()
    const first = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('abc'))
          setTimeout(() => controller.error(new TypeError('connection interrupted')), 10)
        }
      }),
      { headers: headers('abcdef') }
    )
    const request = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(
        new Response('def', {
          status: 206,
          headers: { ...headers('abcdef'), 'Content-Length': '3', 'Content-Range': 'bytes 3-5/6' }
        })
      )
    const progress = vi.fn()
    const result = downloadStudioAsset(request, root, id, auth, progress, store)
    await vi.advanceTimersByTimeAsync(1010)
    expect(await result).toEqual(Buffer.from('abcdef'))
    expect(request.mock.calls[1][1].headers.get('Range')).toBe('bytes=3-')
    expect(request.mock.calls[1][1].headers.get('If-Range')).toBe('"image-v1"')
    expect(progress.mock.lastCall?.[0]).toMatchObject({
      resumedBytes: 3,
      receivedBytes: 6,
      history: [{ reason: 'network' }, {}]
    })
    expect(
      request.mock.calls.every(
        ([, init]) => init.method === 'GET' && init.redirect === 'error' && init.credentials === 'omit'
      )
    ).toBe(true)
  })

  it('keeps a failed partial download across restart and credential scopes', async () => {
    vi.useFakeTimers()
    const { store, directory } = cache()
    const request = vi.fn().mockImplementation(async (_url, init) => {
      if (!init.headers.has('Range'))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('abc'))
              setTimeout(() => controller.error(new Error('broken')), 1)
            }
          }),
          { headers: headers('abcdef') }
        )
      throw new TypeError('connection lost')
    })
    const failure = expect(downloadStudioAsset(request, root, id, auth, vi.fn(), store)).rejects.toThrow(
      'studio_download_failed'
    )
    await vi.advanceTimersByTimeAsync(3001)
    await failure
    const reopened = new StudioDownloadCache(directory)
    expect(reopened.forScope('2'.repeat(64)).load(id)).toBeUndefined()
    const scoped = reopened.forScope('1'.repeat(64))
    expect(scoped.load(id)?.bytes.toString()).toBe('abc')
    const next = vi.fn().mockResolvedValue(
      new Response('def', {
        status: 206,
        headers: { ...headers('abcdef'), 'Content-Length': '3', 'Content-Range': 'bytes 3-5/6' }
      })
    )
    expect(await downloadStudioAsset(next, root, id, auth, vi.fn(), scoped)).toEqual(Buffer.from('abcdef'))
    expect(next.mock.calls[0][1].headers.get('Range')).toBe('bytes=3-')
    for (const file of readdirSync(join(directory, 'downloads')))
      expect(readFileSync(join(directory, 'downloads', file)).includes(Buffer.from('never-log-or-save-this-key'))).toBe(
        false
      )
  })

  it('resumes using the asset size header when a proxy omits Content-Length', async () => {
    vi.useFakeTimers()
    const responseHeaders = { ETag: '"image-v1"', 'X-Image-Bytes': '6', 'X-Image-SHA256': hash('abcdef') }
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('abc'))
              setTimeout(() => controller.error(new Error('interrupted')), 1)
            }
          }),
          { headers: responseHeaders }
        )
      )
      .mockResolvedValueOnce(
        new Response('def', {
          status: 206,
          headers: { ...responseHeaders, 'Content-Range': 'bytes 3-5/6' }
        })
      )
    const progress = vi.fn()
    const result = downloadStudioAsset(request, root, id, auth, progress)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await result).toEqual(Buffer.from('abcdef'))
    expect(request.mock.calls[1][1].headers.get('Range')).toBe('bytes=3-')
    expect(progress.mock.lastCall?.[0]).toMatchObject({ host: 'zenai.925636.xyz', totalBytes: 6, resumedBytes: 3 })
  })

  it.each(['ignored range', 'changed image'])('replaces partial bytes when the server returns 200: %s', async () => {
    const { store } = cache()
    store.save(id, { bytes: Buffer.from('old'), total: 6, etag: '"old-image"' })
    const request = vi.fn().mockResolvedValue(new Response('new-image', { headers: headers('new-image') }))
    expect(await downloadStudioAsset(request, root, id, auth, vi.fn(), store)).toEqual(Buffer.from('new-image'))
  })

  it.each(['wrong offset', 'changed validator', 'changed checksum'])(
    'rejects an unsafe 206 and retries from zero: %s',
    async (type) => {
      vi.useFakeTimers()
      const { store } = cache()
      store.save(id, { bytes: Buffer.from('abc'), total: 6, etag: '"image-v1"', digest: hash('abcdef') })
      const responseHeaders = { ...headers('abcdef'), 'Content-Length': '3', 'Content-Range': 'bytes 3-5/6' }
      if (type === 'wrong offset') responseHeaders['Content-Range'] = 'bytes 2-4/6'
      if (type === 'changed validator') responseHeaders.ETag = '"new"'
      if (type === 'changed checksum') responseHeaders['X-Image-SHA256'] = hash('changed')
      const request = vi
        .fn()
        .mockResolvedValueOnce(new Response('def', { status: 206, headers: responseHeaders }))
        .mockResolvedValueOnce(new Response('abcdef', { headers: headers('abcdef') }))
      const result = downloadStudioAsset(request, root, id, auth, vi.fn(), store)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await result).toEqual(Buffer.from('abcdef'))
      expect(request.mock.calls[1][1].headers.has('Range')).toBe(false)
    }
  )

  it('reconnects on a stalled body with fresh timers and no generation request', async () => {
    vi.useFakeTimers()
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(new ReadableStream()))
      .mockResolvedValueOnce(new Response('ok'))
    const progress = vi.fn()
    const result = downloadStudioAsset(request, root, id, auth, progress)
    await vi.advanceTimersByTimeAsync(31000)
    expect(await result).toEqual(Buffer.from('ok'))
    expect(progress.mock.lastCall?.[0].history[0]).toMatchObject({ reason: 'idle-timeout', httpStatus: 200 })
    expect(request.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('recovers a connection timeout even when the transport ignores abort', async () => {
    vi.useFakeTimers()
    const request = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(new Response('ok'))
    const result = downloadStudioAsset(request, root, id, auth, vi.fn())
    await vi.advanceTimersByTimeAsync(21000)
    expect(await result).toEqual(Buffer.from('ok'))
  })

  it('records edge IDs and stable transport codes without leaking errors or keys', async () => {
    vi.useFakeTimers()
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('net::ERR_CONNECTION_RESET secret-key https://private.test'))
            }
          }),
          { headers: { 'cf-ray': '0123456789abcdef-HKG' } }
        )
      )
      .mockResolvedValue(new Response('ok'))
    const progress = vi.fn()
    const result = downloadStudioAsset(request, root, id, auth, progress)
    await vi.advanceTimersByTimeAsync(1000)
    await result
    expect(progress.mock.lastCall?.[0].history[0]).toMatchObject({
      edgeRequestId: '0123456789abcdef-HKG',
      transportCode: 'ERR_CONNECTION_RESET'
    })
    expect(JSON.stringify(progress.mock.calls)).not.toMatch(/secret-key|private\.test|never-log/)
  })

  it('bounds advertised download size before reading and rejects corrupted bodies', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response('x', { headers: { 'Content-Length': String(21 * 1024 * 1024) } }))
    await expect(downloadStudioAsset(request, root, id, auth, vi.fn())).rejects.toThrow('result_too_large')
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not retry or follow redirects on an unauthorized asset', async () => {
    const request = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 403 }))
    await expect(downloadStudioAsset(request, root, id, auth, vi.fn())).rejects.toThrow('studio_download_failed')
    expect(request).toHaveBeenCalledOnce()
  })

  it('revalidates a complete checkpoint before reusing its body', async () => {
    const { store } = cache()
    store.save(id, { bytes: Buffer.from('abcdef'), total: 6, etag: '"image-v1"', digest: hash('abcdef') })
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 304, headers: { ETag: '"image-v1"' } }))
    expect(await downloadStudioAsset(request, root, id, auth, vi.fn(), store)).toEqual(Buffer.from('abcdef'))
    expect(request.mock.calls[0][1].headers.get('If-None-Match')).toBe('"image-v1"')
    expect(request.mock.calls[0][1].headers.has('Range')).toBe(false)
  })

  it('verifies complete response checksums and discards damaged partial data', async () => {
    vi.useFakeTimers()
    const { store } = cache()
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response('broken', { headers: headers('abcdef') }))
      .mockResolvedValueOnce(new Response('abcdef', { headers: headers('abcdef') }))
    const progress = vi.fn()
    const result = downloadStudioAsset(request, root, id, auth, progress, store)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toEqual(Buffer.from('abcdef'))
    expect(progress.mock.lastCall?.[0].history[0].reason).toBe('integrity')
    expect(request.mock.calls[1][1].headers.has('Range')).toBe(false)
  })

  it('bounds the total download duration while retaining a healthy partial result', async () => {
    vi.useFakeTimers()
    const { store } = cache()
    let timer: ReturnType<typeof setInterval>
    const request = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            timer = setInterval(() => controller.enqueue(new TextEncoder().encode('a')), 20000)
          },
          cancel() {
            clearInterval(timer)
          }
        }),
        { headers: { ETag: '"image-v1"', 'Content-Length': '100' } }
      )
    )
    const progress = vi.fn()
    const failure = expect(downloadStudioAsset(request, root, id, auth, progress, store)).rejects.toThrow(
      'studio_download_failed'
    )
    await vi.advanceTimersByTimeAsync(600000)
    await failure
    expect(request).toHaveBeenCalledOnce()
    expect(progress.mock.lastCall?.[0]).toMatchObject({ state: 'paused', history: [{ reason: 'deadline' }] })
    expect(store.load(id)?.bytes.length).toBeGreaterThan(0)
  })

  it('discards a damaged on-disk checkpoint instead of resuming corrupted bytes', async () => {
    const { store, directory } = cache()
    store.save(id, { bytes: Buffer.from('abc'), total: 6, etag: '"image-v1"' })
    const part = readdirSync(join(directory, 'downloads')).find((name) => name.endsWith('.part'))!
    writeFileSync(join(directory, 'downloads', part), 'xyz')
    expect(store.load(id)).toBeUndefined()
    const request = vi.fn().mockResolvedValue(new Response('abcdef', { headers: headers('abcdef') }))
    expect(await downloadStudioAsset(request, root, id, auth, vi.fn(), store)).toEqual(Buffer.from('abcdef'))
    expect(request.mock.calls[0][1].headers.has('Range')).toBe(false)
  })

  it('restarts after an unsatisfiable range instead of getting stuck on the same offset', async () => {
    vi.useFakeTimers()
    const { store } = cache()
    store.save(id, { bytes: Buffer.from('abc'), total: 6, etag: '"image-v1"' })
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */2' } }))
      .mockResolvedValueOnce(new Response('ok', { headers: headers('ok') }))
    const result = downloadStudioAsset(request, root, id, auth, vi.fn(), store)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toEqual(Buffer.from('ok'))
    expect(request.mock.calls[1][1].headers.has('Range')).toBe(false)
  })
})
