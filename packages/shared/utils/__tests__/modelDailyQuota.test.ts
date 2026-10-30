import { afterEach, describe, expect, it, vi } from 'vitest'

import { sanitizeDiagnostic } from '../../diagnostics'
import { getModelDailyQuotaErrorKind } from '../modelDailyQuota'
import {
  ModelDailyQuotaTask,
  ModelDailyQuotaTurn,
  parseModelDailyTurnResult,
  readModelDailyQuotaResults,
  shouldShowModelDailyQuotaNotice
} from '../modelDailyQuotaTurn'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

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
  it.each([
    [{ name: 'TimeoutError', message: 'signal timed out' }, 'timeout'],
    [JSON.stringify({ name: 'TimeoutError' }), 'timeout'],
    [{ name: 'TypeError', message: 'Failed to fetch' }, 'connection'],
    [{ cause: { code: 'ENOTFOUND' } }, 'connection'],
    [{ name: 'SyntaxError', message: 'Invalid JSON response' }, 'unavailable']
  ])('distinguishes an admission failure caused by %j', (cause, kind) => {
    expect(getModelDailyQuotaErrorKind({ code: 'model_daily_quota_unavailable', cause })).toBe(kind)
  })
  it('keeps actual HTTP failures separate from timeouts and supports saved timeout metadata', () => {
    expect(
      getModelDailyQuotaErrorKind({
        statusCode: 503,
        code: 'model_daily_quota_unavailable',
        message: 'Request timed out on server'
      })
    ).toBe('unavailable')
    expect(
      getModelDailyQuotaErrorKind({ code: 'model_daily_quota_unavailable', cause: '{}', i18nKey: 'request_timeout' })
    ).toBe('timeout')
    expect(getModelDailyQuotaErrorKind({ name: 'TimeoutError' })).toBeUndefined()
  })

  const result = {
    model: 'premium',
    date: '2026-10-29',
    current_date: '2026-10-29',
    limit: 100,
    used: 120,
    exhausted: true,
    extra_allowed: false,
    pending: false
  }
  const headers = () => new Headers({ Authorization: 'Bearer test-key' })
  const signal = () => new AbortController().signal

  it('shares admission with checkpoint calls while isolating models, keys and user tasks', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const body = JSON.parse(String(options?.body))
      return new Response(JSON.stringify({ success: true, data: { ...result, model: body.model } }))
    })
    const task = new ModelDailyQuotaTask()
    const first = await task.headers('https://local.invalid/v1', 'premium', 'key-a', signal())
    expect(first['X-Zen-Model-Turn-Mode']).toBe('inline-v1')
    expect(await task.headers('https://local.invalid/v1', 'premium', 'key-a', signal())).toEqual(first)
    const checkpoint = await task.headers('https://local.invalid/v1', 'checkpoint', 'key-a', signal())
    const failover = await task.headers('https://local.invalid/v1', 'premium', 'key-b', signal())
    expect(new Set([first, checkpoint, failover].map((headers) => headers['X-Zen-Model-Turn'])).size).toBe(3)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await task.finish()).toHaveLength(3)
    await task.finish()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await expect(task.headers('https://local.invalid/v1', 'premium', 'key-a', signal())).rejects.toThrow('finished')
    const nextTask = new ModelDailyQuotaTask()
    expect(await nextTask.headers('https://local.invalid/v1', 'premium', 'key-a', signal())).not.toEqual(first)
    await nextTask.finish()
  })

  it('prepares a private task capability locally even when quota endpoints cannot be reached', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    const turn = new ModelDailyQuotaTurn('https://local.invalid/prefix/v1', 'premium')
    const permit = await turn.getPermit(headers(), signal())
    expect(permit).toMatch(/^[a-f0-9]{64}$/)
    expect(await turn.getPermit(headers(), signal())).toBe(permit)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await turn.finish()).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://local.invalid/prefix/api/usage/token/model-daily/turn/state'
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ model: 'premium', permit, close: true })
  })
  it('shares a capability across parallel calls and returns only a validated final advisory', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(JSON.stringify({ success: true, data: { ...result, permit: 'must-never-persist' } }))
      )
    const turn = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    const permits = await Promise.all([turn.getPermit(headers(), signal()), turn.getPermit(headers(), signal())])
    expect(permits[0]).toBe(permits[1])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await turn.finish()).toEqual(result)
    expect(await turn.finish()).toEqual(result)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(await turn.finish())).not.toContain('must-never-persist')
  })
  it('starts a new capability for a new task, and never leaks it across tasks on the same key', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'))
    const first = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    const other = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    const old = await first.getPermit(headers(), signal())
    expect(await other.getPermit(headers(), signal())).not.toBe(old)
    await first.finish()
    expect(await first.getPermit(headers(), signal())).not.toBe(old)
    await Promise.all([first.finish(), other.finish()])
  })
  it('does not prepare or send anything for an already cancelled task or missing credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const turn = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    const controller = new AbortController()
    const reason = new DOMException('User stopped', 'AbortError')
    controller.abort(reason)
    await expect(turn.getPermit(headers(), controller.signal)).rejects.toBe(reason)
    expect(await turn.getPermit(new Headers(), signal())).toBeUndefined()
    await turn.finish()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('renews an admitted task in the background and stops renewing after completion', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'))
    const turn = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    const permit = await turn.getPermit(headers(), signal())
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ model: 'premium', permit, close: false })
    await turn.finish()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('waits briefly for in-flight settlement instead of fabricating a quota notice', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { ...result, pending: true } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: result })))
    const turn = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    await turn.getPermit(headers(), signal())
    expect(await turn.finish()).toEqual(result)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it.each([
    [503, '{}'],
    [200, '<html>error</html>'],
    [200, '{"success":true,"data":{"exhausted":true}}']
  ])('keeps a completed model result usable if final synchronization returns %s', async (status, body) => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(String(body), { status: Number(status) }))
    const turn = new ModelDailyQuotaTurn('https://local.invalid/v1', 'premium')
    await turn.getPermit(headers(), signal())
    expect(await turn.finish()).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([
    { ...result, pending: true },
    { ...result, extra_allowed: true },
    { ...result, current_date: '2026-10-30' },
    { ...result, limit: 0 },
    { ...result, used: 99 },
    { ...result, exhausted: false }
  ])('does not recommend switching a model for a non-actionable result %j', (value) => {
    expect(shouldShowModelDailyQuotaNotice(value)).toBe(false)
    expect(readModelDailyQuotaResults([value])).toEqual([])
  })
  it('rejects malformed advisories and strips fields not needed for the notice', () => {
    expect(parseModelDailyTurnResult({ ...result, used: -1 })).toBeUndefined()
    expect(parseModelDailyTurnResult({ ...result, used: '120' })).toBeUndefined()
    expect(readModelDailyQuotaResults([null, { ...result, permit: 'private' }])).toEqual([result])
    expect(getModelDailyQuotaErrorKind({ message: '该模型额度已达到日限额，请切换其他模型使用。' })).toBe('exceeded')
  })
})
