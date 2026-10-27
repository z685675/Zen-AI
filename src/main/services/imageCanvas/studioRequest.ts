import { loggerService } from '@logger'
import type { ImageCanvasRequestFailure } from '@shared/config/imageCanvas'

import { type ImageFetch, limitedBytes } from './protocol'

const logger = loggerService.withContext('ImageCanvas')
type Operation = ImageCanvasRequestFailure['operation']
const endpoints: Record<Operation, string> = {
  bootstrap: '/api/image-studio/bootstrap',
  'reference-upload': '/api/image-studio/assets',
  'job-submit': '/api/image-studio/jobs',
  'job-status': '/api/image-studio/jobs/by-submission/:id'
}

function transportCode(error: unknown): string | undefined {
  // Chromium errors often expose only "net::ERR_*"; Node may attach a cause code.
  // Extract the code alone, never the rest of a message (which may contain a URL/key).
  let current = error
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (
      typeof value.code === 'string' &&
      /^(?:ERR_[A-Z_]{1,64}|E(?:CONNRESET|CONNREFUSED|TIMEDOUT|HOSTUNREACH|NETUNREACH|NOTFOUND|AI_AGAIN|PIPE))$/.test(
        value.code
      )
    )
      return value.code
    if (typeof value.message === 'string') {
      const match = /\bnet::(ERR_[A-Z_]{1,64})\b/.exec(value.message)
      if (match) return match[1]
    }
    current = value.cause
  }
  return undefined
}

export class ImageStudioRequestError extends Error {
  constructor(
    readonly failure: ImageCanvasRequestFailure,
    code = failure.reason === 'http' ? `studio_http_${failure.httpStatus}` : 'studio_unavailable'
  ) {
    super(code)
    this.name = 'ImageStudioRequestError'
  }
}

export async function studioJson<T>(
  request: ImageFetch,
  url: string,
  headers: Headers,
  body: BodyInit | undefined,
  options: { operation: Operation; taskId?: string }
): Promise<T> {
  const { operation, taskId } = options
  // Only non-billable preparation may be replayed. Never retry POST /jobs.
  const maxAttempts = operation === 'bootstrap' || operation === 'reference-upload' ? 2 : 1
  const timeoutMs = operation === 'reference-upload' ? 120000 : 30000
  const method = body === undefined ? 'GET' : 'POST'
  headers = new Headers(headers)
  if (taskId && /^[a-f0-9-]{36}$/.test(taskId)) headers.set('X-Image-Studio-Task', taskId)
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs)
    const started = performance.now()
    let response: Response | undefined
    let readingBody = false
    try {
      response = await request(url, { method, headers, body, redirect: 'error', credentials: 'omit', signal })
      if (!response.ok) throw new Error('http')
      readingBody = true
      const headersReceived = performance.now()
      const bytes = await limitedBytes(response, 2 * 1024 * 1024)
      const payload = JSON.parse(new TextDecoder().decode(bytes))
      if (!payload || payload.success !== true || payload.data === undefined) throw new Error('invalid-response')
      if (operation !== 'job-status')
        logger.info('Image studio request completed', {
          taskId,
          operation,
          endpoint: endpoints[operation],
          method,
          httpStatus: response.status,
          attempt,
          headersMs: Math.round(headersReceived - started),
          bodyMs: Math.round(performance.now() - headersReceived),
          durationMs: Math.round(performance.now() - started),
          bytes: bytes.length
        })
      return payload.data as T
    } catch (error) {
      await response?.body?.cancel().catch(() => {})
      const errorName =
        error instanceof Error &&
        ['Error', 'TypeError', 'TimeoutError', 'AbortError', 'SyntaxError'].includes(error.name)
          ? error.name
          : 'Error'
      const reason: ImageCanvasRequestFailure['reason'] =
        signal.aborted || errorName === 'TimeoutError'
          ? 'timeout'
          : response && !response.ok
            ? 'http'
            : error instanceof Error && error.message === 'response_too_large'
              ? 'response-too-large'
              : readingBody && errorName !== 'TypeError' && errorName !== 'AbortError'
                ? 'invalid-response'
                : 'network'
      const networkCode = transportCode(error)
      const failure: ImageCanvasRequestFailure = {
        operation,
        endpoint: endpoints[operation],
        method,
        reason,
        errorName,
        ...(networkCode ? { transportCode: networkCode } : {}),
        ...(response ? { httpStatus: response.status } : {}),
        timeoutMs,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        attempt
      }
      const retryable =
        reason === 'timeout' ||
        reason === 'network' ||
        (reason === 'http' && (response!.status === 408 || response!.status === 429 || response!.status >= 500))
      const willRetry = retryable && attempt < maxAttempts
      // Keep useful transport evidence, but never headers, URLs, bodies or raw exception messages.
      logger.warn('Image studio request failed', { taskId, ...failure, willRetry })
      if (!willRetry) throw new ImageStudioRequestError(failure)
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
    }
  }
  throw new Error('studio_unavailable')
}
