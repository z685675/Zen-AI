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
    await expect(offline.getPermit(headers, new AbortController().signal)).rejects.toThrow('network failure')
    await offline.finish()
  })
})
