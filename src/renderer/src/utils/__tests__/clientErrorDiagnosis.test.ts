import zh from '@renderer/i18n/locales/zh-cn.json'
import { ERROR_I18N_KEY_STREAM_PAUSED } from '@renderer/types/error'
import i18next from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import { diagnoseClientError, formatClientErrorDiagnosis, runClientConnectivityCheck } from '../clientErrorDiagnosis'
import { classifyError } from '../errorClassifier'

beforeAll(async () => {
  await i18next.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zh } } })
})

const baseOptions = {
  blockId: 'block-abcdef',
  messageId: 'message-123456',
  createdAt: '2026-05-09T12:34:56+08:00'
}

it('explains the daily quota without blaming channel connectivity or credentials', () => {
  const diagnosis = diagnoseClientError({
    name: 'APIError',
    message: 'rejected',
    statusCode: 403,
    responseBody: '{"error":{"code":"model_daily_token_limit_exceeded"}}'
  })
  expect(diagnosis.summary).toBe('该模型额度今日已用完，请明日再使用。')
  expect(diagnosis.category).toBe('rate_limited')
  expect(diagnosis.serviceReceived).toBe('是')
})

it('explains an admission timeout without claiming the model received the request or an HTTP 502', () => {
  const error = {
    name: 'AI_ProviderSpecificError',
    message: 'Upstream retry budget exhausted; native task state was preserved',
    statusCode: 502,
    zenFailureStage: 'quota-admission',
    zenRequestUrl: 'https://example.test/api/usage/token/model-daily/turn',
    zenTransportFailure: {
      phase: 'quota-admission',
      receivedResponse: false,
      error: { code: 'model_daily_quota_unavailable', cause: { name: 'TimeoutError' } }
    }
  }
  expect(diagnoseClientError(error)).toMatchObject({
    category: 'service',
    summary: zh.model_daily_quota.unavailable,
    stage: zh.model_daily_quota.stage,
    httpStatus: '无',
    serviceConnectivity: '未确认',
    serviceReceived: '未确认',
    startedGenerating: '否',
    serviceAddress: error.zenRequestUrl
  })
  expect(classifyError(error).i18nKey).toBe('model_daily_quota.unavailable')
})

it('recognizes a direct AI chat admission failure without assuming a server response', () => {
  expect(
    diagnoseClientError({
      name: 'ModelDailyQuotaRequestError',
      message: 'Model daily quota admission request failed',
      code: 'model_daily_quota_unavailable',
      zenFailureStage: 'quota-admission'
    })
  ).toMatchObject({
    category: 'service',
    summary: zh.model_daily_quota.unavailable,
    serviceReceived: '未确认',
    serviceConnectivity: '未确认'
  })
})

it('keeps an actual quota refusal response distinct from an admission connection failure', () => {
  expect(
    diagnoseClientError({
      name: 'APIError',
      message: 'Model daily quota admission refused',
      statusCode: 403,
      zenFailureStage: 'quota-admission',
      zenTransportFailure: {
        phase: 'quota-admission',
        receivedResponse: true,
        status: 403,
        error: { responseBody: '{"error":{"code":"model_daily_token_limit_exceeded"}}' }
      }
    })
  ).toMatchObject({
    category: 'rate_limited',
    summary: zh.model_daily_quota.exceeded,
    serviceReceived: '是',
    serviceConnectivity: '已连接',
    httpStatus: '403'
  })
})

function makeError(message: string, statusCode?: number) {
  return {
    name: 'TestError',
    message,
    stack: null,
    ...(statusCode ? { statusCode } : {})
  }
}

describe('clientErrorDiagnosis', () => {
  it('reports an explicitly stopped response without blaming the connection', () => {
    const diagnosis = diagnoseClientError(
      {
        ...makeError('Request was aborted'),
        name: 'AbortError',
        i18nKey: ERROR_I18N_KEY_STREAM_PAUSED
      },
      baseOptions
    )

    expect(diagnosis).toMatchObject({
      category: 'cancelled',
      title: '已停止',
      serviceConnectivity: '未确认',
      serviceReceived: '未确认',
      startedGenerating: '未确认'
    })
    expect(diagnosis.summary).not.toContain('连接')
    expect(diagnosis.suggestion).not.toMatch(/网络|代理|VPN/)
    expect(formatClientErrorDiagnosis(diagnosis)).toContain('结论：已停止')
  })

  it('does not treat an unmarked AbortError as a user stop', () => {
    const diagnosis = diagnoseClientError({ ...makeError('Request was aborted'), name: 'AbortError' }, baseOptions)

    expect(diagnosis.category).toBe('stream')
    expect(diagnosis.title).toBe('生成中断：连接不稳定')
  })

  it.each(['agent_human_wait_timeout', 'agent_execution_timeout', 'agent_inactivity_timeout'])(
    'identifies %s as a local guard, not a failed network or startup',
    (code) => {
      const error = { ...makeError('saved task state was preserved'), code }
      const diagnosis = diagnoseClientError(error, baseOptions)
      expect(diagnosis.category).toBe('runtime')
      expect(diagnosis.title).toContain('任务已暂停')
      expect(diagnosis.summary).toContain(code === 'agent_human_wait_timeout' ? '30分钟' : '15分钟')
      expect(diagnosis.stage).toBe(
        code === 'agent_human_wait_timeout'
          ? '等待用户操作'
          : code === 'agent_inactivity_timeout'
            ? '监测任务进展'
            : '本地任务执行'
      )
      if (code === 'agent_inactivity_timeout') {
        expect(diagnosis.summary).toContain('连续15分钟')
        expect(diagnosis.summary).not.toContain('累计')
      }
      expect(diagnosis.serviceReceived).toBe('未确认')
      expect(diagnosis.suggestion).not.toContain('网络')
      expect(classifyError(error).navTarget).toBeNull()
      const nested = { ...makeError('wrapped'), cause: JSON.stringify({ code }) }
      expect(diagnoseClientError(nested).title).toBe(diagnosis.title)
      expect(classifyError(makeError('provider timeout')).category).toBe('network')
    }
  )
  it('recognizes the reported Mac native CLI failure before generic stream_error metadata', () => {
    const diagnosis = diagnoseClientError(
      {
        ...makeError(
          'Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.'
        ),
        cause: '{"type":"stream_error","code":"stream_processing_failed"}'
      },
      baseOptions
    )
    expect(diagnosis).toMatchObject({
      category: 'runtime',
      serviceConnectivity: '未确认',
      serviceReceived: '否',
      startedGenerating: '否'
    })
  })

  it('identifies Windows native executable failures as local startup failures', () => {
    expect(
      diagnoseClientError(makeError('spawn C:\\Program Files\\Zen AI\\resources\\claude.exe ENOENT'), baseOptions)
    ).toMatchObject({ category: 'runtime', serviceReceived: '否', startedGenerating: '否' })
  })

  it('identifies a missing packaged Codex binary before a request is sent', () => {
    expect(
      diagnoseClientError(makeError('Agent runtime executable not found: Codex (win32-arm64).'), baseOptions)
    ).toMatchObject({ category: 'runtime', serviceReceived: '否', startedGenerating: '否' })
  })
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
      title: '暂时无法连接模型服务',
      summary: '软件未收到可用响应，现有信息还不能确认服务是否已收到本次请求。',
      stage: '建立连接',
      errorType: '暂时无法连接模型服务',
      serviceConnectivity: '未确认',
      serviceReceived: '未确认',
      startedGenerating: '未确认',
      suggestion: '请先重试；持续失败时请导出诊断包，排查 DNS、证书和软件使用的网络线路。仅在当前网络需要时使用代理。'
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
      serviceConnectivity: '未确认',
      serviceReceived: '未确认',
      startedGenerating: '未确认',
      suggestion: '请重试一次；如果经常在生成中途失败，请优先检查网络、代理或 VPN 稳定性。'
    })
  })

  it('distinguishes missing local Codex resume state from a network interruption', () => {
    const diagnosis = diagnoseClientError(
      makeError('thread/resume failed: no rollout found for thread id stale-thread (code -32600)'),
      baseOptions
    )

    expect(diagnosis).toMatchObject({
      category: 'response',
      title: '任务续接失败：本地会话状态已失效',
      stage: '会话续接',
      errorType: '执行会话已失效',
      serviceReceived: '否',
      startedGenerating: '否',
      suggestion: '请重试一次；智能助手将新建执行会话继续任务。'
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
    expect(text).toContain('结论：暂时无法连接模型服务')
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
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push(typeof input === 'string' ? input : input.toString())
      expect(init?.method).toBe('GET')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer test')
      expect(headers.get('x-zen-request-purpose')).toBe('connectivity-check')
      expect(headers.has('cookie')).toBe(false)
      return new Response('{}', { status: calls.length === 1 ? 200 : 401 })
    }

    const result = await runClientConnectivityCheck(
      'https://example.com/v1/chat/completions',
      {
        headers: {
          Authorization: 'Bearer test',
          'X-Zen-Request-Purpose': 'topic-naming',
          Cookie: 'private-cookie'
        }
      },
      fakeFetch as typeof fetch
    )

    expect(calls).toEqual(['https://example.com/api/status', 'https://example.com/v1/models'])
    expect(result?.serviceStatus).toMatchObject({ reachable: true, ok: true, status: 200 })
    expect(result?.modelsApi).toMatchObject({ reachable: true, ok: false, status: 401 })
  })
})
