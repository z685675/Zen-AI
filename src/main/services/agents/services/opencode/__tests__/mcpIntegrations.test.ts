import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { MCPServer } from '@types'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ select: vi.fn(), initClient: vi.fn() }))
vi.mock('@main/services/ReduxService', () => ({ reduxService: { select: mocks.select } }))
vi.mock('@main/services/MCPService', () => ({ default: { initClient: mocks.initClient } }))

import { createAssistantIntegration, probeAssistantMcp, resolveAssistantMcpIds } from '../mcpIntegrations'

describe('selected assistant MCP service', () => {
  it('connects only trusted, active external servers plus the curated knowledge integration', async () => {
    mocks.select.mockResolvedValue([
      { id: 'trusted', type: 'streamableHttp', baseUrl: 'https://example.test/mcp', isTrusted: true, isActive: true },
      { id: 'untrusted', type: 'stdio', command: 'untested', isActive: true },
      { id: 'inactive', type: 'stdio', command: 'untested', isTrusted: true, isActive: false },
      { id: 'knowledge', name: '@cherry/dify-knowledge', type: 'inMemory', isActive: true },
      { id: 'filesystem', name: '@cherry/filesystem', type: 'inMemory', isActive: true }
    ])
    expect(await resolveAssistantMcpIds(['trusted', 'untrusted', 'inactive', 'knowledge', 'filesystem'])).toEqual([
      'trusted',
      'knowledge'
    ])
  })

  it('filters discovery and rejects a direct call when a tool or server was disabled after discovery', async () => {
    const config: MCPServer = {
      id: 'knowledge',
      name: '@cherry/dify-knowledge',
      type: 'inMemory',
      isActive: true,
      disabledTools: ['list_knowledges']
    }
    mocks.select.mockImplementation(async () => [config])
    const remote = {
      listTools: vi.fn(async () => ({
        tools: ['list_knowledges', 'search_knowledge', 'write_knowledge'].map((name) => ({
          name,
          inputSchema: { type: 'object' }
        }))
      })),
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'Found' }] }))
    }
    mocks.initClient.mockResolvedValue(remote)
    const turn = new AbortController()
    const server = createAssistantIntegration(config.id, () => turn.signal)
    const client = new Client({ name: 'local-test', version: '0' })
    const [left, right] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(left)
      await client.connect(right)
      expect(await probeAssistantMcp(config.id)).toEqual(['search_knowledge'])
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['search_knowledge'])
      await expect(client.callTool({ name: 'write_knowledge' })).rejects.toThrow()
      await expect(
        client.callTool({ name: 'search_knowledge', arguments: { query: 'sample' } })
      ).resolves.toMatchObject({
        content: [{ type: 'text', text: 'Found' }]
      })
      config.isActive = false
      await expect(client.callTool({ name: 'search_knowledge' })).rejects.toThrow()
      expect(remote.callTool).toHaveBeenCalledTimes(1)
    } finally {
      await client.close()
      await server.close()
    }
  })
})
