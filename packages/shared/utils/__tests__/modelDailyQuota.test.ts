import { afterEach, describe, expect, it, vi } from 'vitest'

import { sanitizeDiagnostic } from '../../diagnostics'
import { getModelDailyQuotaErrorKind } from '../modelDailyQuota'
import { ModelDailyQuotaRefusal, ModelDailyQuotaTurn } from '../modelDailyQuotaTurn'

afterEach(() => vi.restoreAllMocks())

describe('model daily quota protocol', () => {
  it('recognizes wrapped errors, but not generic credential/rate-limit failures', () => {
    expect(
      getModelDailyQuotaErrorKind({ cause: { responseBody: '{"error":{"code":"model_daily_token_limit_exceeded"}}' } })
    ).toBe('exceeded')
    expect(getModelDailyQuotaErrorKind({ message: '该模型额度今日已用完，请明日再使用。' })).toBe('exceeded')
    expect(getModelDailyQuotaErrorKind({ message: 'model_daily_token_limit_pending' })).toBe('pending')
    expect(getModelDailyQuotaErrorKind({ message: '该模型剩余额度正在被其他任务使用，请等待任务完成后再试。' })).toBe(
      'pending'
    )
    expect(getModelDailyQuotaErrorKind({ message: '本轮模型授权已结束或过期，请重新发起提问。' })).toBe('invalid')
    expect(getModelDailyQuotaErrorKind({ message: '模型额度服务暂时不可用，请稍后重试。' })).toBe('unavailable')
    expect(getModelDailyQuotaErrorKind({ status: 403, message: 'invalid api key' })).toBeUndefined()
    const cyclic = { cause: {} }
    cyclic.cause = cyclic
    expect(getModelDailyQuotaErrorKind(cyclic)).toBeUndefined()
  })
  it('redacts the permit from objects and text, without removing audit task IDs', () => {
    const value = sanitizeDiagnostic({
      headers: { 'X-Zen-Model-Turn': 'private-permit', 'X-Zen-Task-Id': 'public-task' },
      permit: 'also-private',
      message: 'X-Zen-Model-Turn: private-plain'
    })
    expect(JSON.stringify(value)).not.toContain('private')
    expect(JSON.stringify(value)).toContain('public-task')
  })
  it('falls back only for older server endpoints, not quota errors or network failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }))
    const older = new ModelDailyQuotaTurn('https://local.invalid/prefix/v1', 'premium')
    const headers = new Headers({ Authorization: 'Bearer key' })
    expect(await older.getPermit(headers, new AbortController().signal)).toBeUndefined()
    expect(await older.getPermit(headers, new AbortController().signal)).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://local.invalid/prefix/api/usage/token/model-daily/turn')
    await older.finish()
    fetchMock.mockResolvedValue(new Response('{"error":{"code":"model_daily_token_limit_exceeded"}}', { status: 403 }))
    const limited = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    await expect(limited.getPermit(headers, new AbortController().signal)).rejects.toBeInstanceOf(
      ModelDailyQuotaRefusal
    )
    await limited.finish()
    fetchMock.mockRejectedValue(new Error('network failure'))
    const offline = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    await expect(offline.getPermit(headers, new AbortController().signal)).rejects.toMatchObject({
      code: 'model_daily_quota_unavailable',
      cause: { message: 'network failure' }
    })
    await offline.finish()
  })
  it('retries a failed admission with the same task ID and caches only a successful permit', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { permit: 'a'.repeat(64) } })))
      .mockResolvedValue(new Response('{}'))
    const turn = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    const headers = new Headers({ Authorization: 'Bearer test-only' })
    await expect(turn.getPermit(headers, new AbortController().signal)).rejects.toMatchObject({
      code: 'model_daily_quota_unavailable',
      zenFailureStage: 'quota-admission',
      zenRequestUrl: 'https://local.invalid/api/usage/token/model-daily/turn',
      cause: timeout
    })
    expect(await turn.getPermit(headers, new AbortController().signal)).toBe('a'.repeat(64))
    expect(await turn.getPermit(headers, new AbortController().signal)).toBe('a'.repeat(64))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies[0].task_id).toBe(bodies[1].task_id)
    await turn.finish()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[2][0])).toMatch(/\/turn\/state$/)
  })
  it('shares each in-flight admission, but starts a real new request after a shared failure', async () => {
    let rejectFirst!: (error: Error) => void
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectFirst = reject)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { permit: 'b'.repeat(64) } })))
      .mockResolvedValue(new Response('{}'))
    const turn = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    const headers = new Headers({ Authorization: 'Bearer test-only' })
    const first = Promise.allSettled([
      turn.getPermit(headers, new AbortController().signal),
      turn.getPermit(headers, new AbortController().signal)
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    rejectFirst(new Error('network failure'))
    expect((await first).map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(
      await Promise.all([
        turn.getPermit(headers, new AbortController().signal),
        turn.getPermit(headers, new AbortController().signal)
      ])
    ).toEqual(['b'.repeat(64), 'b'.repeat(64)])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await turn.finish()
  })
  it('does not poison another task on the same Provider, model and key', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { permit: 'c'.repeat(64) } })))
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { permit: 'd'.repeat(64) } })))
      .mockImplementation(async () => new Response('{}'))
    const running = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    const starting = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    const headers = new Headers({ Authorization: 'Bearer test-only' })
    expect(await running.getPermit(headers, new AbortController().signal)).toBe('c'.repeat(64))
    await expect(starting.getPermit(headers, new AbortController().signal)).rejects.toThrow()
    expect(await running.getPermit(headers, new AbortController().signal)).toBe('c'.repeat(64))
    expect(await starting.getPermit(headers, new AbortController().signal)).toBe('d'.repeat(64))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies[0].task_id).not.toBe(bodies[1].task_id)
    expect(bodies[1].task_id).toBe(bodies[2].task_id)
    await Promise.all([running.finish(), starting.finish()])
  })
  it.each([
    [503, '{"error":{"code":"model_daily_quota_unavailable"}}'],
    [403, '{"error":{"code":"model_daily_token_limit_exceeded"}}']
  ])('never bypasses a %s refusal on a subsequent admission attempt', async (status, body) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status }))
    const turn = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    const headers = new Headers({ Authorization: 'Bearer test-only' })
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(turn.getPermit(headers, new AbortController().signal)).rejects.toBeInstanceOf(ModelDailyQuotaRefusal)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await turn.finish()
  })
  it('does not request admission for an already cancelled task', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const turn = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    const controller = new AbortController()
    const reason = new DOMException('User stopped', 'AbortError')
    controller.abort(reason)
    await expect(turn.getPermit(new Headers({ Authorization: 'Bearer test-only' }), controller.signal)).rejects.toBe(
      reason
    )
    expect(fetchMock).not.toHaveBeenCalled()
    await turn.finish()
  })
  it.each(['invalid-json', 'invalid-permit'])(
    'can retry a %s admission response without bypassing authorization',
    async (kind) => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            kind === 'invalid-json' ? '<html>bad gateway</html>' : '{"success":true,"data":{"permit":"bad"}}'
          )
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { permit: 'e'.repeat(64) } })))
        .mockImplementation(async () => new Response('{}'))
      const turn = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
      const headers = new Headers({ Authorization: 'Bearer test-only' })
      await expect(turn.getPermit(headers, new AbortController().signal)).rejects.toMatchObject({
        code: 'model_daily_quota_unavailable'
      })
      expect(await turn.getPermit(headers, new AbortController().signal)).toBe('e'.repeat(64))
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await turn.finish()
    }
  )
  it('preserves cancellation during admission and allows a later real attempt', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { permit: 'f'.repeat(64) } })))
      .mockImplementation(async () => new Response('{}'))
    const turn = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    const headers = new Headers({ Authorization: 'Bearer test-only' })
    const controller = new AbortController()
    const reason = new DOMException('User stopped', 'AbortError')
    const attempt = turn.getPermit(headers, controller.signal)
    controller.abort(reason)
    await expect(attempt).rejects.toBe(reason)
    expect(await turn.getPermit(headers, new AbortController().signal)).toBe('f'.repeat(64))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await turn.finish()
  })
})
