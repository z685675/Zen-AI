import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useToolApproval } from '../useToolApproval'

const mocks = vi.hoisted(() => ({
  mcp: {
    isWaiting: true,
    isExecuting: false,
    isSubmitting: false,
    confirm: vi.fn(),
    cancel: vi.fn(),
    autoApprove: vi.fn()
  },
  agent: {
    isWaiting: true,
    isExecuting: false,
    isSubmitting: false,
    confirm: vi.fn(),
    cancel: vi.fn(),
    autoApprove: undefined
  }
}))
vi.mock('../useMcpToolApproval', () => ({ useMcpToolApproval: () => mocks.mcp }))
vi.mock('../useAgentToolApproval', () => ({ useAgentToolApproval: () => mocks.agent }))

const block = (name: string, type = 'provider') =>
  ({
    metadata: {
      rawMcpToolResponse: {
        tool: { name, type },
        toolCallId: 'session:call',
        status: 'pending'
      }
    }
  }) as any

describe('native permissions do not use the MCP confirmation queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agent.isWaiting = true
  })

  it('approves and rejects native write with the agent request, never MCP or persistent approval', () => {
    const { result } = renderHook(() => useToolApproval(block('write')))
    act(() => {
      void result.current.confirm()
      void result.current.cancel()
    })
    expect(mocks.agent.confirm).toHaveBeenCalledOnce()
    expect(mocks.agent.cancel).toHaveBeenCalledOnce()
    expect(mocks.mcp.confirm).not.toHaveBeenCalled()
    expect(mocks.mcp.cancel).not.toHaveBeenCalled()
    expect(result.current.autoApprove).toBeUndefined()
  })

  it('does not invent MCP approval while the native request is still arriving', () => {
    mocks.agent.isWaiting = false
    const { result } = renderHook(() => useToolApproval(block('write')))
    expect(result.current.isWaiting).toBe(false)
    expect(result.current).toBe(mocks.agent)
  })

  it('routes an unknown native tool to its explicit agent request', () => {
    const { result } = renderHook(() => useToolApproval(block('future-native-tool')))
    expect(result.current).toBe(mocks.agent)
  })

  it('preserves normal MCP/provider and explicit overrides', () => {
    mocks.agent.isWaiting = false
    expect(renderHook(() => useToolApproval(block('server_tool', 'mcp'))).result.current).toBe(mocks.mcp)
    expect(renderHook(() => useToolApproval(block('other-provider'))).result.current).toBe(mocks.mcp)
    expect(renderHook(() => useToolApproval(block('write'), { forceType: 'mcp' })).result.current).toBe(mocks.mcp)
    expect(renderHook(() => useToolApproval(block('server_tool', 'mcp'), { forceType: 'agent' })).result.current).toBe(
      mocks.agent
    )
  })
})
