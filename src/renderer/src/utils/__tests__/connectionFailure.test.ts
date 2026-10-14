import zh from '@renderer/i18n/locales/zh-cn.json'
import i18next from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import { diagnoseClientError } from '../clientErrorDiagnosis'
import { connectionErrorText, getConnectionFailure } from '../connectionFailure'
import { serializeError } from '../error'
import { classifyError } from '../errorClassifier'

beforeAll(async () => {
  await i18next.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zh } } })
})
const wrapper = (code: string, receivedResponse = false, status?: number) => ({
  name: 'Error',
  message: 'Upstream retry budget exhausted',
  stack: null,
  statusCode: 502,
  zenTransportFailure: {
    receivedResponse,
    ...(status ? { status } : {}),
    error: { message: 'fetch failed', cause: { code } }
  }
})
describe('connection evidence diagnosis', () => {
  it.each([
    ['ENOTFOUND', 'dns', '服务地址解析失败'],
    ['EAI_AGAIN', 'dns', '服务地址解析失败'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout', '连接模型服务超时'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'certificate', '无法验证服务证书'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'certificate', '无法验证服务证书'],
    ['ECONNREFUSED', 'connect', '连接模型服务失败']
  ])('explains %s behind a synthetic gateway 502', (code, kind, title) => {
    const error = wrapper(code)
    expect(getConnectionFailure(error)).toMatchObject({ kind, beforeHttp: true })
    expect(diagnoseClientError(error)).toMatchObject({
      title,
      category: 'network',
      httpStatus: '无',
      serviceReceived: '否',
      startedGenerating: '否'
    })
    expect(classifyError(error).category).not.toBe('server')
  })
  it.each([429, 503])('does not blame networking for a real upstream %s', (statusCode) => {
    const error = { name: 'APIError', message: 'connection timeout at upstream', statusCode, stack: null }
    expect(getConnectionFailure(error)).toBeUndefined()
    expect(classifyError(error).category).toBe(statusCode === 429 ? 'quota' : 'server')
    expect(diagnoseClientError(error).serviceReceived).toBe('是')
  })
  it('keeps generic fetch failure ambiguous', () => {
    expect(diagnoseClientError({ name: 'Error', message: 'Failed to fetch', stack: null })).toMatchObject({
      category: 'network',
      serviceReceived: '未确认',
      startedGenerating: '未确认'
    })
  })
  it('recognizes a body break after headers as a stream failure', () => {
    expect(diagnoseClientError(wrapper('ECONNRESET', true, 200))).toMatchObject({
      category: 'stream',
      httpStatus: '200',
      serviceReceived: '是'
    })
  })
  it('bounds cyclic causes and parses JSON-string causes', () => {
    const cyclic: any = { message: 'fetch failed', code: 'EAI_AGAIN' }
    cyclic.cause = cyclic
    expect(connectionErrorText(cyclic)).toContain('eai_again')
    expect(
      getConnectionFailure({
        name: 'Error',
        message: 'fetch failed',
        cause: '{"code":"DEPTH_ZERO_SELF_SIGNED_CERT"}',
        stack: null
      })?.kind
    ).toBe('certificate')
  })
  it('preserves evidence through renderer serialization', () => {
    const input = Object.assign(new Error('retry exhausted'), wrapper('ENOTFOUND'))
    expect(serializeError(input).zenTransportFailure).toEqual(input.zenTransportFailure)
  })
})
