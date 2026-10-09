import Anthropic from '@anthropic-ai/sdk'
import type { MessageCreateParams, MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { Provider } from '@types'
import type { Response as ExpressResponse } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnthropicProtocolBridge } from '../anthropicProtocolBridge'

vi.mock('@main/services/DiagnosticEvidenceService', () => ({ recordMainDiagnostic: vi.fn() }))

const provider = {
  id: 'test-gateway',
  type: 'new-api',
  apiHost: 'https://gateway.invalid/v1',
  apiKey: 'test-only-key',
  models: []
} as unknown as Provider

function upstreamStream(model: string, deltas: Record<string, unknown>[], finish = 'stop') {
  const events = deltas.map((delta) => ({
    id: 'completion-test',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: null }]
  }))
  events.push({
    id: 'completion-test',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finish }]
  } as (typeof events)[number])
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' }
  })
}

// Keep the real Anthropic and AI SDK serializers/parsers. Only the network
// boundary is simulated: no paid requests, credentials or native SDK processes.
function createClient() {
  const bridge = new AnthropicProtocolBridge()
  return new Anthropic({
    apiKey: 'test-client-key',
    maxRetries: 0,
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as MessageCreateParams
      let body = ''
      const response = {
        writableEnded: false,
        destroyed: false,
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write(value: string) {
          body += value
          return true
        },
        end() {
          this.writableEnded = true
        }
      }
      await bridge.handle(provider, request, request.model, response as unknown as ExpressResponse)
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('agent protocol round-trip through real SDK parsers', () => {
  it.each(['gpt-6-luna', 'gemini-test', 'claude-test', 'grok-test'])(
    'continues %s from a tool call through screenshot/results to the final answer',
    async (model) => {
      const upstream = vi.fn()
      upstream.mockResolvedValueOnce(
        upstreamStream(model, [
          {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'Read', arguments: '' } }]
          },
          { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] },
          { tool_calls: [{ index: 0, function: { arguments: '"report.xlsx"}' } }] }
        ])
      )
      upstream.mockResolvedValueOnce(upstreamStream(model, [{ role: 'assistant', content: '表格共有 12 行。' }]))
      vi.stubGlobal('fetch', upstream)
      const client = createClient()
      const tools = [
        { name: 'Read', input_schema: { type: 'object' as const, properties: { path: { type: 'string' } } } }
      ]
      const messages: MessageParam[] = [{ role: 'user', content: '请读取这个表格，告诉我有多少行。' }]
      const first = await client.messages.stream({ model, max_tokens: 2048, tools, messages }).finalMessage()
      expect(first.stop_reason).toBe('tool_use')
      expect(first.content).toContainEqual(
        expect.objectContaining({ type: 'tool_use', input: { path: 'report.xlsx' } })
      )

      const second = await client.messages
        .stream({
          model,
          max_tokens: 2048,
          tools,
          messages: [
            ...messages,
            { role: 'assistant', content: first.content },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'read-1',
                  content: [
                    { type: 'text', text: '表格共有 12 行，下面为预览。' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
                  ]
                }
              ]
            }
          ]
        })
        .finalMessage()
      expect(second.stop_reason).toBe('end_turn')
      expect(second.content).toContainEqual(expect.objectContaining({ type: 'text', text: '表格共有 12 行。' }))
      expect(upstream).toHaveBeenCalledTimes(2)
      const sent = JSON.parse(upstream.mock.calls[1][1].body)
      expect(sent.messages.map((message: { role: string }) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'user'
      ])
      expect(sent.messages[2]).toMatchObject({ tool_call_id: 'read-1' })
      expect(sent.messages[3].content).toContainEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,aGVsbG8=' }
      })
      expect(String(upstream.mock.calls[0][0])).toBe('https://gateway.invalid/v1/chat/completions')
    }
  )

  it.each([
    [403, 'All available accounts exhausted'],
    [429, 'Resource has been exhausted'],
    [503, 'No available channel for model'],
    [524, 'The origin did not respond within 120 seconds']
  ])('preserves HTTP %s and does not add a hidden bridge retry', async (status, message) => {
    const upstream = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message } }), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', upstream)
    await expect(
      createClient()
        .messages.stream({ model: 'gpt-6-luna', max_tokens: 2048, messages: [{ role: 'user', content: '执行任务' }] })
        .finalMessage()
    ).rejects.toThrow(`Upstream HTTP ${status}`)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('does not mark a truncated tool call as a successful tool turn', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        upstreamStream('gpt-6-luna', [
          {
            tool_calls: [
              { index: 0, id: 'broken', type: 'function', function: { name: 'Read', arguments: '{"path":' } }
            ]
          }
        ])
      )
    )
    await expect(
      createClient()
        .messages.stream({
          model: 'gpt-6-luna',
          max_tokens: 2048,
          tools: [{ name: 'Read', input_schema: { type: 'object' } }],
          messages: [{ role: 'user', content: '读取文件' }]
        })
        .finalMessage()
    ).rejects.toThrow(/invalid tool call|incomplete tool arguments/)
  })
})
