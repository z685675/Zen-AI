import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@main/services/agents/services/AgentService', () => ({ agentService: {} }))
vi.mock('@main/services/agents/services/TaskService', () => ({ taskService: { createTask: vi.fn() } }))
vi.mock('@main/services/agents/services/ChannelService', () => ({ channelService: { createChannel: vi.fn() } }))
vi.mock('@main/services/agents/services/channels/ChannelManager', () => ({ channelManager: { syncChannel: vi.fn() } }))
vi.mock('@main/services/agents/skills', () => ({ skillService: {} }))

import { channelService } from '@main/services/agents/services/ChannelService'
import { taskService } from '@main/services/agents/services/TaskService'

import ClawServer from '../claw'

describe('legacy automation MCP shutdown', () => {
  beforeEach(() => vi.clearAllMocks())
  it('no longer advertises legacy integrations or scheduling tools', async () => {
    const server = new ClawServer('legacy')
    const handlers = (server.mcpServer.server as any)._requestHandlers
    const result = await handlers.get('tools/list')({ method: 'tools/list' }, {})
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(['skills', 'memory'])
  })
  it.each(['cron', 'config', 'notify'])('rejects stale %s calls without executing side effects', async (name) => {
    const server = new ClawServer('legacy')
    const handlers = (server.mcpServer.server as any)._requestHandlers
    const result = await handlers.get('tools/call')(
      { method: 'tools/call', params: { name, arguments: { action: 'add' } } },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('已停用')
    expect(taskService.createTask).not.toHaveBeenCalled()
    expect(channelService.createChannel).not.toHaveBeenCalled()
  })
})
