import { describe, expect, it } from 'vitest'

import type { Assistant, MCPServer, MCPTool } from '../../types'
import { getEffectiveMcpMode } from '../../types'
import { getMcpModeForRequest, selectAssistantMcpServers } from '../../utils/mcpMode'

describe('getEffectiveMcpMode', () => {
  it('should return mcpMode when explicitly set to auto', () => {
    const assistant: Partial<Assistant> = { mcpMode: 'auto' }
    expect(getEffectiveMcpMode(assistant as Assistant)).toBe('auto')
  })

  it('should return disabled when mcpMode is explicitly disabled', () => {
    const assistant: Partial<Assistant> = { mcpMode: 'disabled' }
    expect(getEffectiveMcpMode(assistant as Assistant)).toBe('disabled')
  })

  it('should return manual when mcpMode is explicitly manual', () => {
    const assistant: Partial<Assistant> = { mcpMode: 'manual' }
    expect(getEffectiveMcpMode(assistant as Assistant)).toBe('manual')
  })

  it('should return manual when no mcpMode but mcpServers has items (backward compatibility)', () => {
    const assistant: Partial<Assistant> = {
      mcpServers: [{ id: 'test', name: 'Test Server', isActive: true }] as MCPServer[]
    }
    expect(getEffectiveMcpMode(assistant as Assistant)).toBe('manual')
  })

  it('defaults unconfigured assistants to automatic discovery without modifying saved data', () => {
    const assistant: Partial<Assistant> = {}
    expect(getEffectiveMcpMode(assistant as Assistant)).toBe('auto')
    expect(assistant).toEqual({})
  })

  it('defaults an empty server selection to automatic discovery', () => {
    const assistant: Partial<Assistant> = { mcpServers: [] }
    expect(getEffectiveMcpMode(assistant as Assistant)).toBe('auto')
  })

  it('should prioritize explicit mcpMode over mcpServers presence', () => {
    const assistant: Partial<Assistant> = {
      mcpMode: 'disabled',
      mcpServers: [{ id: 'test', name: 'Test Server', isActive: true }] as MCPServer[]
    }
    expect(getEffectiveMcpMode(assistant as Assistant)).toBe('disabled')
  })

  it('should return auto when mcpMode is auto regardless of mcpServers', () => {
    const assistant: Partial<Assistant> = {
      mcpMode: 'auto',
      mcpServers: [{ id: 'test', name: 'Test Server', isActive: true }] as MCPServer[]
    }
    expect(getEffectiveMcpMode(assistant as Assistant)).toBe('auto')
  })
})

const server = (id: string, isActive: boolean): MCPServer => ({ id, name: id, type: 'stdio', isActive })
const assistant = (value: Partial<Assistant> = {}) => value as Assistant
const hubTool = { id: 'hub_list', name: 'list', serverId: 'hub' } as MCPTool

describe('MCP discovery for an actual request', () => {
  it.each([{ servers: [] }, { servers: [server('off', false)] }, { servers: [server('hub', true)] }])(
    'omits discovery when no user-enabled server exists %#',
    ({ servers }) => {
      expect(selectAssistantMcpServers(assistant(), servers)).toEqual([])
    }
  )

  it('exposes only the Hub for automatic discovery without activating or changing services', () => {
    const servers = [server('enabled', true), server('off', false)]
    const original = structuredClone(servers)
    const selected = selectAssistantMcpServers(assistant(), servers)
    expect(selected.map((value) => value.id)).toEqual(['hub'])
    expect(servers).toEqual(original)
  })

  it('preserves disabled mode and restricts manual mode to selected active services', () => {
    const servers = [server('selected', true), server('other', true), server('off', false)]
    const selected = [servers[0], servers[2]]
    expect(selectAssistantMcpServers(assistant({ mcpMode: 'disabled', mcpServers: selected }), servers)).toEqual([])
    expect(selectAssistantMcpServers(assistant({ mcpMode: 'manual', mcpServers: selected }), servers)).toEqual([
      servers[0]
    ])
    expect(selectAssistantMcpServers(assistant({ mcpServers: selected }), servers)).toEqual([servers[0]])
  })

  it('uses automatic instructions only when discovery tools were actually loaded', () => {
    const automatic = assistant({ mcpMode: 'auto' })
    expect(getMcpModeForRequest(automatic)).toBe('disabled')
    expect(getMcpModeForRequest(automatic, [])).toBe('disabled')
    expect(getMcpModeForRequest(automatic, [{ ...hubTool, serverId: 'web-search' }])).toBe('disabled')
    expect(getMcpModeForRequest(automatic, [hubTool])).toBe('auto')
    expect(getMcpModeForRequest(assistant({ mcpMode: 'disabled' }), [hubTool])).toBe('disabled')
    expect(getMcpModeForRequest(assistant({ mcpMode: 'manual' }), [hubTool])).toBe('manual')
  })
})
