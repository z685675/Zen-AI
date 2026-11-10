import { describe, expect, it, vi } from 'vitest'

import {
  isInvalidReadToolLoop,
  isNativePermissionRejection,
  LOOP_SUMMARY_AGENT,
  OpenCodeLoopRecovery
} from '../loopRecovery'

const rejection = {
  name: 'UnknownError',
  data: { message: 'The user rejected permission to use this specific tool call with the following feedback: skip' }
}
const failed = (id = 'failed') => ({
  info: { id, role: 'assistant', error: rejection },
  parts: [
    {
      type: 'tool',
      tool: 'search',
      state: { status: 'completed', title: 'Verified reference', output: 'https://example.org/paper DOI:123' }
    },
    { type: 'tool', tool: 'search', state: { status: 'error', error: 'missing query' } },
    { type: 'file', url: 'data:image/png;base64,PRIVATE_ATTACHMENT' }
  ]
})
function setup() {
  let history: any[] = [failed()]
  const request = vi.fn(async (route: string, _method?: string, body?: any): Promise<any> => {
    if (route.endsWith('/message')) return history
    if (route.endsWith('/prompt_async')) history.push({ info: { id: body.messageID, role: 'user' }, parts: body.parts })
  })
  const recovery = new OpenCodeLoopRecovery()
  const input = {
    client: { request },
    sessionId: 'native',
    previousMessages: new Set<string>(),
    body: {
      agent: 'build',
      model: { modelID: 'local' },
      system: 'workspace rules',
      parts: [{ type: 'text', text: 'ORIGINAL_USER_TASK' }]
    },
    signal: new AbortController().signal,
    onSubmitted: vi.fn()
  }
  return {
    recovery,
    input,
    request,
    setHistory: (value: any[]) => {
      history = value
    }
  }
}

describe('rejected repeated-operation continuation', () => {
  it('recognizes only invalid required arguments on known read-only tools without granting permissions', () => {
    for (const [tool, key] of [
      ['mcp__assistant__web_search', 'query'],
      ['mcp__browser__open', 'url'],
      ['webfetch', 'url']
    ]) {
      for (const input of [{}, { [key]: '' }, { [key]: '  ' }, { [key]: null }])
        expect(isInvalidReadToolLoop('doom_loop', { tool, input })).toBe(true)
      expect(isInvalidReadToolLoop('doom_loop', { tool, input: { [key]: 'valid' } })).toBe(false)
      expect(isInvalidReadToolLoop('external_directory', { tool, input: {} })).toBe(false)
    }
    for (const tool of ['mcp__browser__list_tabs', 'bash', 'edit', 'mcp__assistant__create_file', 'unknown'])
      expect(isInvalidReadToolLoop('doom_loop', { tool, input: {} })).toBe(false)
    expect(isInvalidReadToolLoop('doom_loop', undefined)).toBe(false)
    expect(isInvalidReadToolLoop('doom_loop', { tool: 'webfetch', input: undefined })).toBe(false)
  })
  it('repairs an invalid batch once then summarizes available evidence without further tool use', async () => {
    const { recovery, input, request, setHistory } = setup()
    recovery.reject('invalid-1', 'mcp__assistant__web_search', {}, 'invalid-arguments')
    expect(await recovery.resume(input)).toMatchObject({ attempt: 1, finalizing: false, reason: 'invalid-arguments' })
    expect(request.mock.calls.at(-1)![2].parts[0].text).toContain('ONE corrected tool call')
    expect(request.mock.calls.at(-1)![2].parts[0].text).not.toContain('The user chose to skip')
    setHistory([failed('invalid-again')])
    recovery.reject('invalid-2', 'mcp__browser__open', {}, 'invalid-arguments')
    expect(await recovery.resume(input)).toMatchObject({ attempt: 2, finalizing: true })
    expect(request.mock.calls.at(-1)![2]).toMatchObject({ agent: LOOP_SUMMARY_AGENT })
    expect(request.mock.calls.at(-1)![2].parts[0].text).toContain('https://example.org/paper DOI:123')
  })
  it('rejects the repetition then continues the same history without replaying original input or attachments', async () => {
    const { recovery, input, request } = setup()
    expect(await recovery.resume(input)).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
    recovery.reject('per-loop', 'search', { query: 'REJECTED_QUERY' })
    expect(recovery.expects(rejection)).toBe(true)
    const result = await recovery.resume(input)
    expect(result).toMatchObject({ attempt: 1, finalizing: false })
    expect(request.mock.calls.map(([route]) => route)).toEqual([
      '/session/native/abort',
      '/session/native/message',
      '/session/native/prompt_async'
    ])
    const body = request.mock.calls.at(-1)![2]
    expect(body).toMatchObject({ agent: 'build', system: 'workspace rules', parts: [{ synthetic: true }] })
    expect(body.parts[0].text).toContain('https://example.org/paper DOI:123')
    expect(body.parts[0].text).toContain('NOT to stop the task')
    expect(body.parts[0].text).toContain('REJECTED_QUERY')
    expect(JSON.stringify(body)).not.toMatch(/ORIGINAL_USER_TASK|PRIVATE_ATTACHMENT|missing query/)
    expect(recovery.recoveredMessage('failed')).toBe(true)
    expect(recovery.waiting).toBe(false)
    expect(await recovery.resume(input)).toBeUndefined()
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })
  it('does not recover unrelated provider errors or failures from an earlier turn', async () => {
    const { recovery, input, request, setHistory } = setup()
    recovery.reject('per-loop')
    setHistory([
      {
        ...failed(),
        info: { id: 'failed', role: 'assistant', error: { name: 'APIError', data: { message: 'provider failed' } } }
      }
    ])
    expect(await recovery.resume(input)).toBeUndefined()
    input.previousMessages.add('failed')
    setHistory([failed()])
    expect(await recovery.resume(input)).toBeUndefined()
    expect(request.mock.calls.some(([route]) => route.endsWith('/prompt_async'))).toBe(false)
    expect(isNativePermissionRejection({ name: 'APIError', data: { message: 'Permission denied' } })).toBe(false)
  })
  it('settles native cleanup before reading successful evidence and never replays an ambiguous admission', async () => {
    const { recovery, input, request } = setup()
    recovery.reject('per-loop')
    const original = request.getMockImplementation()!
    request.mockImplementation(async (...args) => {
      const result = await original(...args)
      if (args[0].endsWith('/prompt_async')) throw new Error('connection lost after admission')
      return result
    })
    expect(await recovery.resume(input)).toMatchObject({ attempt: 1 })
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })
  it('fails honestly if the synthetic continuation cannot be confirmed, without resubmitting', async () => {
    const { recovery, input, request } = setup()
    recovery.reject('per-loop')
    const original = request.getMockImplementation()!
    request.mockImplementation(async (...args) => {
      if (args[0].endsWith('/prompt_async')) throw new Error('admission unknown')
      return original(...args)
    })
    await expect(recovery.resume(input)).rejects.toThrow('admission unknown')
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })
  it('bounds attempts and switches only the fallback to a tool-free agent without changing session permissions', async () => {
    const { recovery, input, request, setHistory } = setup()
    for (let i = 1; i <= 3; i++) {
      setHistory([failed(`failed-${i}`)])
      recovery.reject(`per-${i}`)
      expect(await recovery.resume(input)).toMatchObject({ attempt: i, finalizing: i === 3 })
    }
    const posts = request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))
    expect(posts.map((call) => call[2].agent)).toEqual(['build', 'build', LOOP_SUMMARY_AGENT])
    expect(posts.every((call) => !('tools' in call[2]))).toBe(true)
    recovery.reject('per-4')
    await expect(recovery.resume(input)).rejects.toMatchObject({ code: 'agent_loop_recovery_exhausted' })
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(3)
  })
  it('obeys an explicit task stop and limits copied evidence', async () => {
    const { recovery, input, request, setHistory } = setup()
    const entry = failed()
    entry.parts = Array.from({ length: 12 }, () => ({
      type: 'tool',
      tool: 'search',
      state: { status: 'completed', title: 'paper', output: '\u0001"\\'.repeat(60_000) }
    })) as any
    setHistory([entry])
    recovery.reject('per-loop')
    await recovery.resume(input)
    expect(request.mock.calls.at(-1)![2].parts[0].text.length).toBeLessThan(52_000)
    const controller = new AbortController()
    controller.abort('user stopped')
    recovery.reject('per-2')
    await expect(recovery.resume({ ...input, signal: controller.signal })).rejects.toBe('user stopped')
    expect(request.mock.calls.filter(([route]) => route.endsWith('/prompt_async'))).toHaveLength(1)
  })
})
