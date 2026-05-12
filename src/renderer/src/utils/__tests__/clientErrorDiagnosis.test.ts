import { describe, expect, it } from 'vitest'

import { diagnoseClientError, formatClientErrorDiagnosis, runClientConnectivityCheck } from '../clientErrorDiagnosis'

const baseOptions = {
  blockId: 'block-abcdef',
  messageId: 'message-123456',
  createdAt: '2026-05-09T12:34:56+08:00'
}

function makeError(message: string, statusCode?: number) {
  return {
    name: 'TestError',
    message,
    stack: null,
    ...(statusCode ? { statusCode } : {})
  }
}

describe('clientErrorDiagnosis', () => {
  it('uses exact reviewed Chinese copy for account permission errors', () => {
    const diagnosis = diagnoseClientError(makeError('unauthorized', 401), baseOptions)

    expect(diagnosis).toMatchObject({
      title: '生成失败：账号权限异常',
      summary: '当前账号暂时无法使用该模型。请联系管理员检查账号状态、可用额度或模型权限。',
      stage: '请求校验',
      errorType: '账号权限异常',
      serviceConnectivity: '已连接',
      serviceReceived: '是',
      startedGenerating: '否',
      suggestion: '请确认账号状态、可用额度和模型权限；如果刚调整过权限，请稍后重试。'
    })
  })

  it('uses exact reviewed Chinese copy for rate limit errors', () => {
    const diagnosis = diagnoseClientError(makeError('rate_limit', 429), baseOptions)

    expect(diagnosis).toMatchObject({
      title: '生成失败：请求过于频繁',
      summary: '当前请求频率较高，请稍后再试。如果持续出现，请联系管理员检查账号限制。',
      stage: '请求校验',
      errorType: '频率限制',
      serviceConnectivity: '已连接',
      serviceReceived: '是',
      startedGenerating: '否',
      suggestion: '请等待一小段时间后重试；如果多人同时使用同一账号，请降低并发频率。'
    })
  })

  it('uses exact reviewed Chinese copy for model permission errors', () => {
    const diagnosis = diagnoseClientError(makeError('model_not_found', 404), baseOptions)

    expect(diagnosis).toMatchObject({
      title: '生成失败：模型权限异常',
      summary: '当前账号暂时无法使用所选模型，或模型名称不可用。请联系管理员检查模型权限。',
      stage: '模型校验',
      errorType: '模型不可用',
      serviceConnectivity: '已连接',
      serviceReceived: '是',
      startedGenerating: '否',
      suggestion: '请确认所选模型是否仍可使用，必要时切换到其他模型后重试。'
    })
  })

  it('uses exact reviewed Chinese copy for context length errors', () => {
    const diagnosis = diagnoseClientError(makeError('context_length_exceeded'), baseOptions)

    expect(diagnosis).toMatchObject({
      title: '生成失败：上下文过长',
      summary: '本次对话或文件内容较长，超过了当前模型可处理的范围。',
      stage: '请求准备',
      errorType: '上下文超限',
      serviceConnectivity: '未确认',
      serviceReceived: '未确认',
      startedGenerating: '否',
      suggestion: '请减少附件、缩短历史对话，或开启一个新对话后重试。'
    })
  })

  it('uses exact reviewed Chinese copy for payload size errors', () => {
    const diagnosis = diagnoseClientError(makeError('payload too large', 413), baseOptions)

    expect(diagnosis).toMatchObject({
      title: '生成失败：请求内容过大',
      summary: '本次发送的文件或文本内容过大，当前服务未能接收完整请求。',
      stage: '请求上传',
      errorType: '内容过大',
      serviceConnectivity: '已连接',
      serviceReceived: '是',
      startedGenerating: '否',
      suggestion: '请压缩或拆分文件，减少一次性发送的内容后重试。'
    })
  })

  it('uses exact reviewed Chinese copy for timeout errors', () => {
    const diagnosis = diagnoseClientError(makeError('request timeout', 504), baseOptions)

    expect(diagnosis).toMatchObject({
      title: '生成失败：响应超时',
      summary: '模型服务响应时间较长，请稍后重试，或尝试切换模型。',
      stage: '等待响应',
      errorType: '响应超时',
      serviceConnectivity: '已连接',
      serviceReceived: '是',
      startedGenerating: '未确认',
      suggestion: '请重试一次；如果连续出现，可先切换模型或检查当前网络稳定性。'
    })
  })

  it('uses exact reviewed Chinese copy for connection errors', () => {
    const diagnosis = diagnoseClientError(makeError('Failed to fetch'), baseOptions)

    expect(diagnosis).toMatchObject({
      title: '生成失败：连接异常',
      summary: '暂时无法连接到模型服务。请重试一次；如果连续失败，请检查网络、代理或 VPN 设置。',
      stage: '建立连接',
      errorType: '连接异常',
      serviceConnectivity: '未确认',
      serviceReceived: '未确认',
      startedGenerating: '否',
      suggestion: '请先重试；如果仍失败，请检查当前设备网络、代理、VPN 或安全软件拦截。'
    })
  })

  it('uses exact reviewed Chinese copy for model service errors', () => {
    const diagnosis = diagnoseClientError(makeError('bad gateway', 502), baseOptions)

    expect(diagnosis).toMatchObject({
      title: '生成失败：模型服务暂时不可用',
      summary: '模型服务当前响应异常，请稍后重试。',
      stage: '模型服务响应',
      errorType: '服务响应异常',
      serviceConnectivity: '已连接',
      serviceReceived: '是',
      startedGenerating: '未确认',
      suggestion: '请稍后重试；如果同一模型连续失败，请联系管理员并提供诊断编号。'
    })
  })

  it('uses exact reviewed Chinese copy for stream interruption errors', () => {
    const diagnosis = diagnoseClientError(makeError('context canceled'), baseOptions)

    expect(diagnosis).toMatchObject({
      title: '生成中断：连接不稳定',
      summary: '回复生成过程中连接中断。通常重试即可恢复；如果连续出现，请检查网络或代理设置。',
      stage: '生成传输',
      errorType: '连接中断',
      serviceConnectivity: '已连接',
      serviceReceived: '是',
      startedGenerating: '是',
      suggestion: '请重试一次；如果经常在生成中途失败，请优先检查网络、代理或 VPN 稳定性。'
    })
  })

  it('uses exact reviewed Chinese copy for content restriction errors', () => {
    const diagnosis = diagnoseClientError(makeError('content_filter safety', 400), baseOptions)

    expect(diagnosis).toMatchObject({
      title: '生成失败：内容无法处理',
      summary: '本次输入内容未能通过模型服务的处理规则。请调整表述后重试。',
      stage: '内容校验',
      errorType: '内容限制',
      serviceConnectivity: '已连接',
      serviceReceived: '是',
      startedGenerating: '否',
      suggestion: '请修改敏感、模糊或过于复杂的描述后再试。'
    })
  })

  it('uses exact reviewed Chinese copy for response parse errors', () => {
    const diagnosis = diagnoseClientError(makeError('invalid response json'), baseOptions)

    expect(diagnosis).toMatchObject({
      title: '生成失败：响应处理异常',
      summary: '当前应用未能正确处理本次响应。请重试；如果持续出现，请保存详情并反馈给管理员。',
      stage: '响应处理',
      errorType: '响应格式异常',
      serviceConnectivity: '未确认',
      serviceReceived: '未确认',
      startedGenerating: '未确认',
      suggestion: '请重试一次；如果持续出现，请提供诊断编号和错误详情。'
    })
  })

  it('uses exact reviewed Chinese copy for unknown errors', () => {
    const diagnosis = diagnoseClientError(makeError('something unexpected'), baseOptions)

    expect(diagnosis).toMatchObject({
      title: '生成失败：未知异常',
      summary: '本次请求未能完成。请重试一次；如果持续出现，请保存详情并反馈给管理员。',
      stage: '未确认',
      errorType: 'TestError',
      serviceConnectivity: '未确认',
      serviceReceived: '未确认',
      startedGenerating: '未确认',
      suggestion: '请重试一次；如果连续出现，请提供诊断编号和错误详情。'
    })
  })

  it('copies the human-readable diagnosis before technical details without mojibake', () => {
    const diagnosis = diagnoseClientError(makeError('Failed to fetch'), baseOptions)
    const text = `${formatClientErrorDiagnosis(diagnosis)}\n\n【技术详情】\nAI_ProviderSpecificError: Failed to fetch`

    expect(text).toContain('【诊断摘要】')
    expect(text).toContain('结论：生成失败：连接异常')
    expect(text).toContain('服务地址检测：未确认')
    expect(text).toContain('模型接口检测：未确认')
    expect(text).toContain('【技术详情】')
    expect(text).not.toMatch(/[�]|鐢熸垚|璇锋眰|鏈‘璁|宸茶繛鎺/)
  })

  it('uses connectivity check result in diagnosis fields', () => {
    const diagnosis = diagnoseClientError(
      {
        ...makeError('Failed to fetch'),
        zenConnectivityCheck: {
          checkedAt: '2026-05-09T12:35:00+08:00',
          serviceStatus: { ok: true, reachable: true, status: 200, durationMs: 123 },
          modelsApi: { ok: false, reachable: true, status: 401, durationMs: 88 }
        }
      },
      baseOptions
    )

    expect(diagnosis.serviceConnectivity).toBe('正常')
    expect(diagnosis.serviceStatusCheck).toBe('正常，123ms')
    expect(diagnosis.modelApiCheck).toBe('可访问，但返回 HTTP 401，88ms')
  })

  it('checks service status and models API from the failed request origin', async () => {
    const calls: string[] = []
    const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
      calls.push(typeof input === 'string' ? input : input.toString())
      return new Response('{}', { status: calls.length === 1 ? 200 : 401 })
    }

    const result = await runClientConnectivityCheck(
      'https://example.com/v1/chat/completions',
      {
        headers: {
          Authorization: 'Bearer test'
        }
      },
      fakeFetch as typeof fetch
    )

    expect(calls).toEqual(['https://example.com/api/status', 'https://example.com/v1/models'])
    expect(result?.serviceStatus).toMatchObject({ reachable: true, ok: true, status: 200 })
    expect(result?.modelsApi).toMatchObject({ reachable: true, ok: false, status: 401 })
  })
})
