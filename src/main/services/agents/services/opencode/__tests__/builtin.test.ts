import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ init: vi.fn(), provision: vi.fn() }))
vi.mock('../../AgentService', () => ({ agentService: { initBuiltinAgent: mocks.init } }))
vi.mock('../../builtin/BuiltinAgentProvisioner', () => ({ provisionBuiltinAgent: mocks.provision }))
import { ensureOpenCodeAgent } from '../builtin'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.provision.mockResolvedValue({
    instructions: 'Exa scheduler legacy prompt',
    configuration: { permission_mode: 'bypassPermissions', soul_enabled: true }
  })
  mocks.init.mockImplementation(async ({ provisionWorkspace }) => {
    await provisionWorkspace('/owned-workspace')
    return 'zen-opencode-default'
  })
})
describe('new assistant managed identity', () => {
  it('provisions shared Skills but replaces unsupported legacy instructions and defaults', async () => {
    expect(await ensureOpenCodeAgent()).toBe('zen-opencode-default')
    const options = mocks.init.mock.calls[0][0]
    const config = await options.provisionWorkspace('/owned-workspace')
    expect(config.name).toBe('智能助手')
    expect(mocks.provision).toHaveBeenCalledWith('/owned-workspace', 'fusion')
    expect(config.instructions).not.toContain('legacy prompt')
    expect(config.configuration).toMatchObject({
      avatar: '❤️',
      assistant_engine: 'opencode',
      permission_mode: 'default',
      soul_enabled: false,
      scheduler_enabled: false,
      heartbeat_enabled: false
    })
  })
  it('shares simultaneous initialization and permits retry when no model exists', async () => {
    mocks.init.mockResolvedValue(null)
    const first = ensureOpenCodeAgent()
    expect(ensureOpenCodeAgent()).toBe(first)
    expect(await first).toBeNull()
    await ensureOpenCodeAgent()
    expect(mocks.init).toHaveBeenCalledTimes(2)
  })
})
