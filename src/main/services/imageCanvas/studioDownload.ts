import { createHash } from 'node:crypto'

import { loggerService } from '@logger'
import type { ImageCanvasDownloadAttempt, ImageCanvasDownloadProgress } from '@shared/config/imageCanvas'

import { clientResponseRoute } from '../modelTransport/routes'
import type { ImageFetch } from './protocol'
import { type DownloadCheckpoints, maxDownloadBytes, strongImageEtag } from './StudioDownloadCache'
import { studioDownloadAddressStrategy } from './studioTransport'

const logger = loggerService.withContext('ImageCanvas')
const connectTimeout = 20000
const idleTimeout = 30000
const totalTimeout = 10 * 60 * 1000
const maxAttempts = 3
type Reason = NonNullable<ImageCanvasDownloadAttempt['reason']>
const integer = (value: string | null) =>
  value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function transportCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  return /\bnet::(ERR_[A-Z_]{1,64})\b/.exec(error.message)?.[1]
}

export async function downloadStudioAsset(
  request: ImageFetch,
  root: string,
  id: string,
  auth: Headers,
  progress: (value: ImageCanvasDownloadProgress) => void,
  checkpoints?: DownloadCheckpoints
): Promise<Buffer> {
  const saved = checkpoints?.load(id)
  const host = new URL(root).hostname
  let chunks: Uint8Array[] = saved ? [saved.bytes] : []
  let received = saved?.bytes.length || 0
  let total = saved?.total
  let etag = saved?.etag
  let digest = saved?.digest
  let lastReport = 0
  const history: ImageCanvasDownloadAttempt[] = []
  const began = performance.now()
  const publish = (state: ImageCanvasDownloadProgress['state'], attempt: number, resumedBytes: number, speed = 0) => {
    progress({
      assetId: id,
      host,
      index: 1,
      count: 1,
      state,
      attempt,
      receivedBytes: received,
      totalBytes: total,
      bytesPerSecond: speed,
      resumedBytes,
      history: history.map((entry) => ({ ...entry }))
    })
  }
  const reset = () => {
    chunks = []
    received = 0
    total = undefined
    etag = undefined
    digest = undefined
    checkpoints?.remove(id)
  }
  if (saved && received === total) {
    if (digest && createHash('sha256').update(saved.bytes).digest('hex') !== digest) reset()
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = performance.now()
    const controller = new AbortController()
    let reason: Reason | undefined
    let retryable = true
    let transferred = 0
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let response: Response | undefined
    const detail: ImageCanvasDownloadAttempt = { attempt, offset: received, transferredBytes: 0, durationMs: 0 }
    const abort = (why: Reason) => {
      reason = why
      controller.abort(new DOMException(why, 'TimeoutError'))
      void reader?.cancel().catch(() => {})
    }
    let timer = setTimeout(() => abort('connect-timeout'), connectTimeout)
    const deadline = setTimeout(() => abort('deadline'), Math.max(1, totalTimeout - (started - began)))
    const resetIdle = () => {
      clearTimeout(timer)
      timer = setTimeout(() => abort('idle-timeout'), idleTimeout)
    }
    const fail = (why: Reason) => {
      reason = why
      throw new Error('studio_download_failed')
    }
    publish(attempt === 1 ? 'connecting' : 'reconnecting', attempt, detail.offset)
    try {
      const headers = new Headers(auth)
      for (const name of ['Range', 'If-Range', 'If-None-Match', 'If-Modified-Since']) headers.delete(name)
      // Byte offsets must address the identity representation. Older servers may
      // ignore Range; their HTTP 200 body replaces, rather than appends to, a part.
      headers.set('Accept-Encoding', 'identity')
      if (received && strongImageEtag(etag || null)) {
        if (received === total) headers.set('If-None-Match', etag!)
        else {
          headers.set('Range', `bytes=${received}-`)
          headers.set('If-Range', etag!)
        }
      }
      response = await abortable(
        request(`${root}/assets/${id}`, {
          method: 'GET',
          headers,
          redirect: 'error',
          credentials: 'omit',
          signal: controller.signal
        }),
        controller.signal
      )
      detail.httpStatus = response.status
      detail.addressStrategy = studioDownloadAddressStrategy(response)
      const route = clientResponseRoute(response)
      if (route) {
        Object.assign(detail, route)
        if (route.route === 'ip-direct') detail.addressStrategy = 'ipv4'
      }
      detail.headersMs = Math.round(performance.now() - started)
      const ray = response.headers.get('cf-ray')
      if (ray && /^[a-f0-9]{8,32}-[A-Z]{3}$/.test(ray)) detail.edgeRequestId = ray
      if (response.status === 304) {
        if (!received || received !== total || response.headers.get('etag') !== etag) {
          reset()
          fail('invalid-response')
        }
        detail.durationMs = Math.round(performance.now() - started)
        history.push(detail)
        publish('completed', attempt, detail.offset)
        return Buffer.concat(chunks)
      }
      if (!response.ok) {
        retryable =
          response.status === 408 || response.status === 429 || response.status >= 500 || response.status === 416
        if (response.status === 416) reset()
        fail('http')
      }
      resetIdle()
      const encoding = response.headers.get('content-encoding')
      const identity = !encoding || encoding.toLowerCase() === 'identity'
      const responseEtag = response.headers.get('etag')
      const length = integer(response.headers.get('content-length'))
      const advertisedTotal = integer(response.headers.get('x-image-bytes'))
      const responseDigest = response.headers.get('x-image-sha256')
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '')
        if (
          !identity ||
          !received ||
          !etag ||
          responseEtag !== etag ||
          !range ||
          Number(range[1]) !== received ||
          Number(range[2]) !== Number(range[3]) - 1 ||
          Number(range[3]) !== total ||
          (advertisedTotal !== undefined && advertisedTotal !== total) ||
          (length !== undefined && length !== total - received)
        ) {
          reset()
          fail('invalid-response')
        }
        if (digest && responseDigest !== digest) {
          reset()
          fail('integrity')
        }
      } else if (response.status === 200) {
        reset()
        if (identity && advertisedTotal !== undefined && length !== undefined && advertisedTotal !== length) {
          fail('invalid-response')
        }
        total = identity ? (advertisedTotal ?? length) : undefined
        etag = identity && strongImageEtag(responseEtag) ? responseEtag : undefined
        digest = identity && responseDigest && /^[a-f0-9]{64}$/.test(responseDigest) ? responseDigest : undefined
      } else {
        reset()
        fail('invalid-response')
      }
      if (total !== undefined && (total < 1 || total > maxDownloadBytes)) {
        reset()
        retryable = false
        fail('too-large')
      }
      reader = response.body?.getReader()
      if (!reader) fail('invalid-response')
      publish('downloading', attempt, detail.offset)
      while (true) {
        const { done, value } = await abortable(reader!.read(), controller.signal)
        if (controller.signal.aborted) throw controller.signal.reason
        if (done) break
        if (!value.length) continue
        resetIdle()
        received += value.length
        transferred += value.length
        if (received > maxDownloadBytes || (total !== undefined && received > total)) {
          reset()
          retryable = false
          fail('too-large')
        }
        chunks.push(value)
        if (performance.now() - lastReport >= 500) {
          publish(
            'downloading',
            attempt,
            detail.offset,
            Math.round((transferred * 1000) / Math.max(1, performance.now() - started))
          )
          lastReport = performance.now()
        }
      }
      if (!received || (total !== undefined && received !== total)) fail('network')
      const bytes = Buffer.concat(chunks)
      if (digest && createHash('sha256').update(bytes).digest('hex') !== digest) {
        reset()
        fail('integrity')
      }
      detail.transferredBytes = transferred
      detail.durationMs = Math.round(performance.now() - started)
      history.push(detail)
      if (etag && total) checkpoints?.save(id, { bytes, etag, total, digest })
      publish('completed', attempt, detail.offset)
      logger.info('Image asset download completed', { assetId: id, host, ...detail, bytes: bytes.length })
      return bytes
    } catch (error) {
      reason ??= 'network'
      detail.reason = reason
      detail.transferredBytes = transferred
      detail.durationMs = Math.round(performance.now() - started)
      detail.transportCode = transportCode(error)
      history.push(detail)
      // Resume only a known, strongly validated identity representation. Old API
      // versions and compressed responses remain fully supported without resume.
      if (etag && total && received) checkpoints?.save(id, { bytes: Buffer.concat(chunks), etag, total, digest })
      else reset()
      const willRetry =
        retryable && reason !== 'deadline' && attempt < maxAttempts && performance.now() - began < totalTimeout
      publish(willRetry ? 'reconnecting' : 'paused', attempt, detail.offset)
      logger.warn('Image asset download failed', {
        assetId: id,
        host,
        ...detail,
        receivedBytes: received,
        totalBytes: total,
        willRetry
      })
      if (!willRetry) throw new Error(reason === 'too-large' ? 'result_too_large' : 'studio_download_failed')
    } finally {
      clearTimeout(timer)
      clearTimeout(deadline)
      // Cancellation is best-effort: never wait for a stalled network to close.
      if (reader) void reader.cancel().catch(() => {})
      else void response?.body?.cancel().catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
  }
  throw new Error('studio_download_failed')
}
