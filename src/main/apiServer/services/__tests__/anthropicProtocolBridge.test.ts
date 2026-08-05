import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages'
import type { TextStreamPart, ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  buildBridgeReasoningProviderOptions,
  convertAnthropicMessagesToModelMessages,
  convertToolChoice,
  extractBridgeReasoningEffort,
  translateAiSdkStreamToAnthropicEvents
} from '../anthropicProtocolBridge'

const request = (messages: MessageCreateParams['messages']): MessageCreateParams => ({
  model: 'gemini-2.5-pro',
  max_tokens: 2048,
  messages
})

async function* streamParts(parts: TextStreamPart<ToolSet>[]): AsyncGenerator<TextStreamPart<ToolSet>> {
  yield* parts
}

describe('Anthropic protocol bridge', () => {
  it('requires a tool call for Zen AI execution-marked requests', () => {
    const bridgedRequest = request([{ role: 'user', content: '请执行\n<zen-ai-tool-required>' }])
    bridgedRequest.tools = [
      {
        name: 'mcp__assistant__create_file',
        description: 'Create a file',
        input_schema: { type: 'object', properties: {} }
      }
    ]

    expect(convertToolChoice(bridgedRequest)).toBe('required')
  })

  it('does not force tools for ordinary turns', () => {
    const bridgedRequest = request([{ role: 'user', content: '请解释一下这个文件的内容' }])
    bridgedRequest.tools = [
      {
        name: 'mcp__assistant__create_file',
        description: 'Create a file',
        input_schema: { type: 'object', properties: {} }
      }
    ]

    expect(convertToolChoice(bridgedRequest)).toBeUndefined()
  })

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['max', 'xhigh']
  ] as const)('preserves %s as %s for OpenAI-compatible GPT models', (input, expected) => {
    const bridgedRequest = {
      ...request([{ role: 'user', content: 'Think carefully.' }]),
      output_config: { effort: input }
    } as MessageCreateParams

    expect(extractBridgeReasoningEffort(bridgedRequest)).toBe(expected)
    expect(buildBridgeReasoningProviderOptions('openai-chat', 'gateway', bridgedRequest)).toEqual({
      'zen-gateway': { reasoningEffort: expected }
    })
    expect(buildBridgeReasoningProviderOptions('openai-responses', 'openai', bridgedRequest)).toEqual({
      openai: { reasoningEffort: expected }
    })
  })

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['max', 'high']
  ] as const)('maps %s to Gemini native thinking level %s', (input, expected) => {
    const bridgedRequest = {
      ...request([{ role: 'user', content: 'Think carefully.' }]),
      output_config: { effort: input }
    } as MessageCreateParams

    expect(buildBridgeReasoningProviderOptions('gemini', 'gemini', bridgedRequest)).toEqual({
      google: { thinkingConfig: { includeThoughts: true, thinkingLevel: expected } }
    })
  })

  it.each([
    ['low', 'low'],
    ['medium', 'low'],
    ['high', 'high'],
    ['max', 'high']
  ] as const)('maps %s to Grok chat effort %s', (input, expected) => {
    const bridgedRequest = {
      ...request([{ role: 'user', content: 'Think carefully.' }]),
      output_config: { effort: input }
    } as MessageCreateParams

    expect(buildBridgeReasoningProviderOptions('xai-chat', 'grok', bridgedRequest)).toEqual({
      xai: { reasoningEffort: expected }
    })
  })

  it('preserves assistant tool calls and maps following tool results', () => {
    const messages = convertAnthropicMessagesToModelMessages(
      request([
        { role: 'user', content: 'Create a file.' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will create it.' },
            { type: 'tool_use', id: 'call-1', name: 'Write', input: { path: 'demo.md' } }
          ]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'created' }]
        }
      ])
    )

    expect(messages).toEqual([
      { role: 'user', content: 'Create a file.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will create it.' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'Write', input: { path: 'demo.md' } }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'Write',
            output: { type: 'text', value: 'created' }
          }
        ]
      }
    ])
  })

  it('converts Claude Code tool references returned by ToolSearch', () => {
    const messages = convertAnthropicMessagesToModelMessages(
      request([
        { role: 'user', content: 'Create a presentation.' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'search-1',
              name: 'ToolSearch',
              input: { query: 'create presentation' }
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'search-1',
              content: [
                { type: 'tool_reference', tool_name: 'mcp__assistant__create_file' },
                { type: 'tool_reference', tool_name: 'Write' }
              ]
            }
          ]
        }
      ] as MessageCreateParams['messages'])
    )

    expect(messages.at(-1)).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'search-1',
          toolName: 'ToolSearch',
          output: {
            type: 'text',
            value: '[Tool available: mcp__assistant__create_file]\n[Tool available: Write]'
          }
        }
      ]
    })
  })

  it('preserves unknown tool result content without crashing the bridge', () => {
    const messages = convertAnthropicMessagesToModelMessages(
      request([
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-1', name: 'FutureTool', input: {} }]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              content: [{ type: 'future_result', value: 42 }]
            }
          ]
        }
      ] as MessageCreateParams['messages'])
    )

    expect(messages.at(-1)).toMatchObject({
      role: 'tool',
      content: [
        {
          toolName: 'FutureTool',
          output: {
            type: 'text',
            value: '[Tool result content (future_result)]: {"type":"future_result","value":42}'
          }
        }
      ]
    })
  })

  it('translates streamed text into Anthropic content block events', async () => {
    const parts = [
      { type: 'start' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', text: 'hello' },
      { type: 'text-end', id: 'text-1' },
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: undefined,
        totalUsage: {
          inputTokens: 10,
          inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokens: 2,
          outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
          totalTokens: 12,
          raw: undefined
        }
      }
    ] as TextStreamPart<ToolSet>[]

    const events = []
    for await (const event of translateAiSdkStreamToAnthropicEvents(streamParts(parts), {
      messageId: 'msg-test',
      modelId: 'gemini-2.5-pro'
    })) {
      events.push(event)
    }

    expect(events.map((event) => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(events[2]).toMatchObject({ delta: { type: 'text_delta', text: 'hello' } })
    expect(events[4]).toMatchObject({
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 10, output_tokens: 2 }
    })
  })

  it('translates streamed tool arguments and reports tool_use as the stop reason', async () => {
    const parts = [
      { type: 'tool-input-start', id: 'call-1', toolName: 'Write' },
      { type: 'tool-input-delta', id: 'call-1', delta: '{"path":"demo.md"}' },
      { type: 'tool-input-end', id: 'call-1' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        rawFinishReason: undefined,
        totalUsage: {
          inputTokens: 20,
          inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokens: 8,
          outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
          totalTokens: 28,
          raw: undefined
        }
      }
    ] as TextStreamPart<ToolSet>[]

    const events = []
    for await (const event of translateAiSdkStreamToAnthropicEvents(streamParts(parts), {
      messageId: 'msg-test',
      modelId: 'grok-4'
    })) {
      events.push(event)
    }

    expect(events[1]).toMatchObject({
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'call-1', name: 'Write' }
    })
    expect(events[2]).toMatchObject({
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: '{"path":"demo.md"}' }
    })
    expect(events.at(-2)).toMatchObject({ delta: { stop_reason: 'tool_use' } })
  })

  it('backfills complete tool input when a provider emits no argument deltas', async () => {
    const parts = [
      { type: 'tool-input-start', id: 'call-2', toolName: 'Write' },
      { type: 'tool-input-end', id: 'call-2' },
      {
        type: 'tool-call',
        toolCallId: 'call-2',
        toolName: 'Write',
        input: { path: 'fallback.md' },
        providerExecuted: false,
        dynamic: false
      }
    ] as TextStreamPart<ToolSet>[]

    const events = []
    for await (const event of translateAiSdkStreamToAnthropicEvents(streamParts(parts), {
      messageId: 'msg-test',
      modelId: 'gemini-2.5-pro'
    })) {
      events.push(event)
    }

    expect(events).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"path":"fallback.md"}' }
    })
  })
})
