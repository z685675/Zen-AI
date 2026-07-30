import { describe, expect, it } from 'vitest'

import {
  CodexStreamState,
  mapCodexApprovalPolicy,
  mapCodexReasoningEffort,
  transformCodexEventToStreamParts
} from '../transform'

describe('Codex transform', () => {
  it('streams agent_message updates as incremental text chunks', () => {
    const state = new CodexStreamState()
    const parts = [
      ...transformCodexEventToStreamParts({ type: 'turn.started' }, state),
      ...transformCodexEventToStreamParts(
        {
          type: 'item.started',
          item: {
            id: 'msg-1',
            type: 'agent_message',
            text: 'Hello'
          }
        },
        state
      ),
      ...transformCodexEventToStreamParts(
        {
          type: 'item.updated',
          item: {
            id: 'msg-1',
            type: 'agent_message',
            text: 'Hello world'
          }
        },
        state
      ),
      ...transformCodexEventToStreamParts(
        {
          type: 'item.completed',
          item: {
            id: 'msg-1',
            type: 'agent_message',
            text: 'Hello world'
          }
        },
        state
      )
    ]

    expect(parts.map((part) => part.type)).toEqual(['start-step', 'text-start', 'text-delta', 'text-delta', 'text-end'])
    expect(parts.filter((part) => part.type === 'text-delta').map((part: any) => part.text)).toEqual([
      'Hello',
      ' world'
    ])
  })

  it('streams reasoning updates as incremental reasoning chunks', () => {
    const state = new CodexStreamState()
    const parts = [
      ...transformCodexEventToStreamParts(
        {
          type: 'item.started',
          item: {
            id: 'reasoning-1',
            type: 'reasoning',
            text: 'Plan'
          }
        },
        state
      ),
      ...transformCodexEventToStreamParts(
        {
          type: 'item.completed',
          item: {
            id: 'reasoning-1',
            type: 'reasoning',
            text: 'Plan carefully'
          }
        },
        state
      )
    ]

    expect(parts.map((part) => part.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-delta',
      'reasoning-end'
    ])
    expect(parts.filter((part) => part.type === 'reasoning-delta').map((part: any) => part.text)).toEqual([
      'Plan',
      ' carefully'
    ])
  })

  it('turns command executions into tool-call and tool-result chunks', () => {
    const state = new CodexStreamState()
    const parts = [
      ...transformCodexEventToStreamParts(
        {
          type: 'item.started',
          item: {
            id: 'cmd-1',
            type: 'command_execution',
            command: 'dir',
            aggregated_output: '',
            status: 'in_progress'
          }
        },
        state
      ),
      ...transformCodexEventToStreamParts(
        {
          type: 'item.completed',
          item: {
            id: 'cmd-1',
            type: 'command_execution',
            command: 'dir',
            aggregated_output: 'ok',
            exit_code: 0,
            status: 'completed'
          }
        },
        state
      )
    ]

    expect(parts.map((part) => part.type)).toEqual(['tool-call', 'raw', 'tool-result'])
    const toolCall = parts.find((part) => part.type === 'tool-call') as any
    expect(toolCall.toolName).toBe('codex.command_execution')
    expect(toolCall.input).toEqual({ command: 'dir' })

    const result = parts.find((part) => part.type === 'tool-result') as any
    expect(result.toolCallId).toBe('cmd-1')
    expect(result.output).toBe('ok')
  })

  it('turns failed MCP calls into tool-error chunks', () => {
    const state = new CodexStreamState()
    const parts = transformCodexEventToStreamParts(
      {
        type: 'item.completed',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'assistant',
          tool: 'create_file',
          arguments: { path: 'deck.pptx' },
          error: { message: 'failed' },
          status: 'failed'
        }
      },
      state
    )

    expect(parts.map((part) => part.type)).toEqual(['tool-call', 'tool-error'])
    const error = parts.find((part) => part.type === 'tool-error') as any
    expect(error.toolName).toBe('mcp__assistant__create_file')
    expect(error.input).toEqual({ path: 'deck.pptx' })
    expect(error.error).toBe('failed')
  })

  it('emits finish-step and finish with converted usage on turn completion', () => {
    const state = new CodexStreamState()
    transformCodexEventToStreamParts({ type: 'thread.started', thread_id: 'thread-1' }, state)
    transformCodexEventToStreamParts({ type: 'turn.started' }, state)

    const parts = transformCodexEventToStreamParts(
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 3,
          output_tokens: 8,
          reasoning_output_tokens: 5
        }
      },
      state
    )

    expect(parts.map((part) => part.type)).toEqual(['finish-step', 'finish'])
    const finishStep = parts[0] as any
    expect(finishStep.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 8,
      totalTokens: 18,
      inputTokenDetails: { cacheReadTokens: 3, noCacheTokens: 7 },
      outputTokenDetails: { textTokens: 3, reasoningTokens: 5 }
    })
  })

  it('keeps Codex error items non-fatal while preserving fatal turn errors', () => {
    const state = new CodexStreamState()
    const warningParts = transformCodexEventToStreamParts(
      {
        type: 'item.completed',
        item: {
          id: 'warning-1',
          type: 'error',
          message: 'Model metadata not found. Defaulting to fallback metadata.'
        }
      },
      state
    )

    expect(warningParts).toHaveLength(1)
    expect(warningParts[0]).toMatchObject({
      type: 'raw',
      rawValue: {
        type: 'codex_warning',
        message: 'Model metadata not found. Defaulting to fallback metadata.'
      }
    })

    const fatalParts = transformCodexEventToStreamParts(
      {
        type: 'turn.failed',
        error: { message: 'Request failed' }
      },
      state
    )
    expect(fatalParts).toHaveLength(1)
    expect(fatalParts[0]).toMatchObject({ type: 'error' })
  })

  it('maps Codex options from existing agent controls', () => {
    expect(mapCodexReasoningEffort('minimal')).toBe('minimal')
    expect(mapCodexReasoningEffort('low')).toBe('low')
    expect(mapCodexReasoningEffort('medium')).toBe('medium')
    expect(mapCodexReasoningEffort('high')).toBe('high')
    expect(mapCodexReasoningEffort('max')).toBe('xhigh')
    expect(mapCodexReasoningEffort('default')).toBeUndefined()
    expect(mapCodexApprovalPolicy('bypassPermissions')).toBe('never')
    expect(mapCodexApprovalPolicy('default')).toBe('on-request')
  })
})
