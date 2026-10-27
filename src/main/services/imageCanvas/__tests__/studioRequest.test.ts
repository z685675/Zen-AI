import { loggerService } from '@logger'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ImageStudioRequestError, studioJson } from '../studioRequest'

const auth = new Headers({ Authorization: 'Bearer secret-key' })
const ok = () => new Response(JSON.stringify({ success: true, data: { id: 'asset-id' } }))
const upload = (request: typeof fetch) =>
  studioJson(request, 'https://zenai.925636.xyz/api/image-studio/assets', auth, new FormData(), {
    operation: 'reference-upload',
    taskId: 'test-task'
  })

function mockTimeouts() {
  vi.useFakeTimers()
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms)
    return controller.signal
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('image studio request boundaries', () => {
  it('allows a reference upload to finish after the former 30-second limit', async () => {
    const timeout = mockTimeouts()
    const request = vi.fn(async (_url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 45000))
      expect(init.signal.aborted).toBe(false)
      return ok()
    })
    const result = upload(request)
    await vi.advanceTimersByTimeAsync(45000)
    await expect(result).resolves.toEqual({ id: 'asset-id' })
    expect(timeout).toHaveBeenCalledWith(120000)
    expect(request).toHaveBeenCalledOnce()
  })

  it('bounds uploads to two attempts with independent timeouts and preserves timeout evidence', async () => {
    mockTimeouts()
    const request = vi.fn(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        })
    )
    const result = expect(upload(request)).rejects.toMatchObject({
      failure: {
        operation: 'reference-upload',
        reason: 'timeout',
        errorName: 'TimeoutError',
        endpoint: '/api/image-studio/assets',
        timeoutMs: 120000,
        attempt: 2
      }
    })
    await vi.advanceTimersByTimeAsync(241000)
    await result
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0][1].signal).not.toBe(request.mock.calls[1][1].signal)
  })

  it('retries a temporary configuration error without sending a generation request', async () => {
    vi.useFakeTimers()
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(ok())
    const result = studioJson(request, 'https://zenai.925636.xyz/api/image-studio/bootstrap', auth, undefined, {
      operation: 'bootstrap'
    })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(result).resolves.toEqual({ id: 'asset-id' })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true)
  })

  it.each([400, 401, 403, 404, 413])('does not repeat a rejected HTTP %s upload', async (status) => {
    const request = vi.fn().mockResolvedValue(new Response('private response', { status }))
    await expect(upload(request)).rejects.toMatchObject({
      message: `studio_http_${status}`,
      failure: { reason: 'http', httpStatus: status, attempt: 1 }
    })
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not replay malformed successful responses or misreport HTTP 200 as a server error', async () => {
    const request = vi.fn().mockResolvedValue(new Response('<html>private body</html>'))
    await expect(upload(request)).rejects.toMatchObject({
      message: 'studio_unavailable',
      failure: { reason: 'invalid-response', httpStatus: 200, errorName: 'SyntaxError' }
    })
    expect(request).toHaveBeenCalledOnce()
  })

  it('never automatically repeats the billable generation POST', async () => {
    const request = vi.fn().mockRejectedValue(new TypeError('connection lost after accepting request'))
    await expect(
      studioJson(request, 'https://zenai.925636.xyz/api/image-studio/jobs', auth, '{}', {
        operation: 'job-submit',
        taskId: 'test-task'
      })
    ).rejects.toBeInstanceOf(ImageStudioRequestError)
    expect(request).toHaveBeenCalledOnce()
  })

  it('records transport evidence without credentials, full URLs or raw upstream errors', async () => {
    const log = vi.spyOn(loggerService, 'warn').mockImplementation(() => {})
    const request = vi.fn().mockRejectedValue(new TypeError('failed https://secret.test?key=secret-key private-body'))
    await expect(
      studioJson(request, 'https://secret.test/private?key=secret-key', auth, '{}', {
        operation: 'job-submit',
        taskId: 'test-task'
      })
    ).rejects.toMatchObject({ failure: { reason: 'network', errorName: 'TypeError' } })
    const evidence = JSON.stringify(log.mock.calls)
    expect(evidence).toContain('/api/image-studio/jobs')
    for (const secret of ['secret.test', 'secret-key', 'private-body', 'Authorization'])
      expect(evidence).not.toContain(secret)
  })
  it.each([
    [new Error('net::ERR_CONNECTION_RESET at https://secret.test?key=secret-key'), 'ERR_CONNECTION_RESET'],
    [new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED', address: 'private-host' } }), 'ECONNREFUSED']
  ])('retains a safe network code from %s without copying private error details', async (error, code) => {
    const request = vi.fn().mockRejectedValue(error)
    let failure: unknown
    try {
      await studioJson(request, 'https://zenai.925636.xyz/api/image-studio/jobs', auth, '{}', {
        operation: 'job-submit'
      })
    } catch (caught) {
      failure = caught
    }
    expect(failure).toMatchObject({ failure: { transportCode: code } })
    for (const secret of ['secret.test', 'secret-key', 'private-host'])
      expect(JSON.stringify(failure)).not.toContain(secret)
  })
})
