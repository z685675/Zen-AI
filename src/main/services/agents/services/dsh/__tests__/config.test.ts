import type { GetAgentSessionResponse, Provider } from '@types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  gateway: vi.fn(),
  register: vi.fn(),
  browser: vi.fn(),
  cleanup: vi.fn(),
  server: vi.fn(),
  record: vi.fn(),
  operation: vi.fn(),
  stop: vi.fn(),
  finish: vi.fn(),
  list: vi.fn()
}))
vi.mock('node:fs/promises', () => ({
  default: { mkdir: vi.fn(), readdir: vi.fn(async () => []), lstat: vi.fn(async () => ({})), symlink: vi.fn() }
}))
vi.mock('@main/apiServer/config', () => ({
  config: { get: async () => ({ host: '0.0.0.0', port: 12345, apiKey: 'private-mcp-token' }) }
}))
vi.mock('@main/apiServer/routes/assistant-mcp', () => ({
  registerAssistantMcpContext: mocks.register,
  cleanupAssistantMcpContext: mocks.cleanup
}))
vi.mock('@main/apiServer/routes/browser-mcp', () => ({
  registerBrowserMcpContext: mocks.browser,
  cleanupBrowserMcpContext: mocks.cleanup
}))
vi.mock('@main/apiServer/services/mcp', () => ({ mcpApiService: { getServerInfo: mocks.server } }))
vi.mock('@main/services/DiagnosticEvidenceService', () => ({ recordMainDiagnostic: mocks.record }))
vi.mock('@main/utils', () => ({ getDataPath: () => '/private' }))
vi.mock('../../../skills/SkillRepository', () => ({ SkillRepository: { getInstance: () => ({ list: mocks.list }) } }))
vi.mock('../../opencode/fileApproval', () => ({ confirmAssistantFileOverwrite: vi.fn(async () => false) }))
vi.mock('../../opencode/gateway', () => ({ createOpenCodeGateway: mocks.gateway }))

import { dshProviderConfig, prepareDshConfig } from '../config'

const provider = {
  id: 'custom',
  type: 'openai',
  apiHost: 'https://api.925636.xyz/v1',
  apiKey: 'selected-secret',
  models: [{ id: 'custom-model' }]
} as Provider
const session = {
  id: 'session',
  model: 'custom:custom-model',
  accessible_paths: ['/workspace'],
  instructions: 'Always explain the business impact.',
  configuration: {},
  mcps: ['external/id']
} as GetAgentSessionResponse

beforeEach(() => {
  vi.clearAllMocks()
  mocks.list.mockResolvedValue([])
  mocks.server.mockResolvedValue({ id: 'external/id' })
  mocks.gateway.mockResolvedValue({
    baseURL: 'http://127.0.0.1:9876/v1',
    token: 'private-gateway-token',
    setOperation: mocks.operation,
    stop: mocks.stop,
    finishTurn: mocks.finish
  })
})

describe('DSH selected provider and product capabilities', () => {
  it('preserves custom instructions, selected MCP, native skill discovery, quota and diagnostics', async () => {
    const readSkills = vi.fn(async () => [{ name: 'selected-skill' }])
    const prepared = await prepareDshConfig(
      session,
      provider,
      'custom-model',
      new AbortController().signal,
      readSkills,
      'high',
      'operation-1'
    )
    expect(prepared.config.instructions).toContain(session.instructions)
    expect(prepared.config.instructions).not.toContain('skill requires name')
    expect(prepared.config.mcp).toHaveLength(3)
    expect(prepared.config.mcp?.[2]).toMatchObject({ url: 'http://127.0.0.1:12345/v1/mcps/external%2Fid/mcp' })
    expect(prepared.config.approveToolPrefixes?.[0]).toMatch(/^mcp__external_[a-f0-9]+__$/)
    expect(mocks.register).toHaveBeenCalledWith(session.id, session.accessible_paths, expect.any(Object))
    expect(await mocks.register.mock.calls[0][2].readNativeSkills()).toEqual([{ name: 'selected-skill' }])
    expect(mocks.gateway.mock.calls[0][2]).toBe('custom-model')
    expect(mocks.operation).toHaveBeenCalledWith('operation-1')
    mocks.gateway.mock.calls[0][1]('operation-1', 'headers-received', { runtime: 'opencode', durationMs: 50 })
    expect(mocks.record).toHaveBeenCalledWith('operation-1', 'transport', 'headers-received', {
      runtime: 'dsh',
      durationMs: 50
    })
    await prepared.finishTurn()
    prepared.dispose()
    expect(mocks.finish).toHaveBeenCalledOnce()
    expect(mocks.stop).toHaveBeenCalledOnce()
  })

  it('rejects selected missing MCP and unsupported legacy allowlists instead of ignoring them', async () => {
    mocks.server.mockResolvedValue(null)
    await expect(
      prepareDshConfig(session, provider, 'custom-model', new AbortController().signal, () => undefined)
    ).rejects.toThrow('Selected MCP')
    expect(mocks.stop).toHaveBeenCalledOnce()
    await expect(
      prepareDshConfig(
        { ...session, allowed_tools: ['legacy-tool'] },
        provider,
        'custom-model',
        new AbortController().signal,
        () => undefined
      )
    ).rejects.toThrow('allowlist')
  })

  it('selects explicit OpenAI Responses and Anthropic protocols and rejects unsupported auth', () => {
    expect(dshProviderConfig({ ...provider, type: 'openai-response' }, 'custom-model', 'session').api).toBe(
      'openai-responses'
    )
    expect(dshProviderConfig({ ...provider, type: 'anthropic' }, 'custom-model', 'session').api).toBe(
      'anthropic-messages'
    )
    expect(() => dshProviderConfig({ ...provider, type: 'gemini' }, 'custom-model', 'session')).toThrow('Gemini')
    expect(() => dshProviderConfig({ ...provider, type: 'azure-openai' }, 'custom-model', 'session')).toThrow(
      'authentication/protocol'
    )
  })
})
