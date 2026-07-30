import { describe, expect, it, vi } from 'vitest'

vi.mock('@main/apiServer/utils', () => ({
  validateModelId: vi.fn()
}))

vi.mock('../../claudecode', () => ({
  default: vi.fn().mockImplementation(() => ({ id: 'claude-service' }))
}))

vi.mock('../../codex', () => ({
  default: vi.fn().mockImplementation(() => ({ id: 'codex-service' }))
}))

import { getAgentRuntimeService, resolveAgentRuntime } from '../registry'

const validModel = (provider: Record<string, unknown>, modelId: string) => async () => ({
  valid: true as const,
  provider: {
    id: 'test-provider',
    apiKey: 'test-key',
    apiHost: 'https://example.com',
    enabled: true,
    name: 'Test Provider',
    models: [{ id: modelId, provider: 'test-provider', name: modelId, group: 'default' }],
    ...provider
  },
  modelId
})

describe('runtime registry', () => {
  it('keeps Claude Code as the legacy fallback when the model cannot be resolved', async () => {
    const session = { agent_type: 'claude-code' as const }

    await expect(resolveAgentRuntime(session)).resolves.toMatchObject({
      runtimeId: 'claude-code',
      source: 'legacy-fallback'
    })
    await expect(getAgentRuntimeService(session)).resolves.toMatchObject({ id: 'claude-service' })
  })

  it('prefers Codex for GPT models on a declared OpenAI endpoint', async () => {
    const resolution = await resolveAgentRuntime(
      {
        agent_type: 'claude-code',
        model: 'openai:gpt-5.4-mini',
        configuration: { agent_runtime: 'auto' }
      },
      {
        codexEnabled: true,
        validateModel: validModel({ type: 'openai' }, 'gpt-5.4-mini')
      }
    )

    expect(resolution.runtimeId).toBe('codex')
    expect(resolution.candidates).toEqual(['codex', 'claude-code'])
  })

  it('prefers Claude Code for Claude models even when an OpenAI provider has no Anthropic metadata', async () => {
    const resolution = await resolveAgentRuntime(
      {
        agent_type: 'claude-code',
        model: 'gateway:claude-opus-4-6',
        configuration: { agent_runtime: 'auto' }
      },
      {
        codexEnabled: true,
        validateModel: validModel({ type: 'openai' }, 'claude-opus-4-6')
      }
    )

    expect(resolution.runtimeId).toBe('claude-code')
    expect(resolution.candidates).toEqual(['claude-code', 'codex'])
    expect(resolution.capabilities?.['claude-code']).toMatchObject({
      state: 'declared',
      evidence: ['zen-protocol-bridge-openai-chat']
    })
  })

  it('allows model affinity to rank unverified mixed-gateway candidates', async () => {
    const resolution = await resolveAgentRuntime(
      {
        agent_type: 'claude-code',
        model: 'new-api:gpt-5.4-mini'
      },
      {
        codexEnabled: true,
        validateModel: validModel({ type: 'new-api' }, 'gpt-5.4-mini')
      }
    )

    expect(resolution.runtimeId).toBe('codex')
    expect(resolution.capabilities?.codex.state).toBe('unknown')
  })

  it('routes Gemini models imported through OpenAI-compatible providers to the Claude Code bridge first', async () => {
    const resolution = await resolveAgentRuntime(
      {
        agent_type: 'claude-code',
        model: 'panel:gemini-2.5-pro',
        configuration: { agent_runtime: 'auto' }
      },
      {
        codexEnabled: true,
        validateModel: validModel({ type: 'openai' }, 'gemini-2.5-pro')
      }
    )

    expect(resolution.runtimeId).toBe('claude-code')
    expect(resolution.candidates).toEqual(['claude-code', 'codex'])
  })

  it('routes the built-in Grok provider to the Claude Code bridge first', async () => {
    const resolution = await resolveAgentRuntime(
      {
        agent_type: 'claude-code',
        model: 'grok:grok-4',
        configuration: { agent_runtime: 'auto' }
      },
      {
        codexEnabled: true,
        validateModel: validModel({ id: 'grok', type: 'openai' }, 'grok-4')
      }
    )

    expect(resolution.runtimeId).toBe('claude-code')
    expect(resolution.candidates).toEqual(['claude-code', 'codex'])
  })

  it('routes native Gemini providers to the bridge even without an OpenAI-compatible endpoint', async () => {
    const resolution = await resolveAgentRuntime(
      {
        agent_type: 'claude-code',
        model: 'gemini:gemini-2.5-pro',
        configuration: { agent_runtime: 'auto' }
      },
      {
        codexEnabled: true,
        validateModel: validModel({ id: 'gemini', type: 'gemini' }, 'gemini-2.5-pro')
      }
    )

    expect(resolution.runtimeId).toBe('claude-code')
    expect(resolution.capabilities?.['claude-code'].state).toBe('declared')
  })

  it('excludes a runtime only when supported endpoint metadata explicitly rules it out', async () => {
    const modelId = 'gpt-through-anthropic'
    const resolution = await resolveAgentRuntime(
      {
        agent_type: 'claude-code',
        model: `gateway:${modelId}`
      },
      {
        codexEnabled: true,
        validateModel: async () => ({
          valid: true,
          provider: {
            id: 'gateway',
            type: 'new-api',
            name: 'Gateway',
            apiKey: 'test-key',
            apiHost: 'https://example.com',
            enabled: true,
            models: [
              {
                id: modelId,
                provider: 'gateway',
                name: modelId,
                group: 'default',
                supported_endpoint_types: ['anthropic']
              }
            ]
          },
          modelId
        })
      }
    )

    expect(resolution.candidates).toEqual(['claude-code'])
  })

  it('ignores persisted runtime choices unless the internal configuration override is enabled', async () => {
    const session = {
      agent_type: 'claude-code' as const,
      model: 'openai:gpt-5.4-mini',
      configuration: { agent_runtime: 'claude-code' as const }
    }
    const validateModel = validModel({ type: 'openai' }, 'gpt-5.4-mini')

    await expect(resolveAgentRuntime(session, { codexEnabled: true, validateModel })).resolves.toMatchObject({
      runtimeId: 'codex',
      source: 'auto'
    })

    await expect(
      resolveAgentRuntime(session, {
        env: { ZEN_ENABLE_AGENT_RUNTIME_CONFIG_OVERRIDE: 'true' },
        codexEnabled: true,
        validateModel
      })
    ).resolves.toMatchObject({ runtimeId: 'claude-code', source: 'configuration-override' })
  })

  it('supports a hidden environment override for developer diagnostics', async () => {
    const resolution = await resolveAgentRuntime(
      {
        agent_type: 'claude-code',
        model: 'openai:gpt-5.4-mini'
      },
      {
        env: { ZEN_AGENT_RUNTIME_OVERRIDE: 'claude-code' },
        codexEnabled: true,
        validateModel: validModel({ type: 'openai' }, 'gpt-5.4-mini')
      }
    )

    expect(resolution).toMatchObject({ runtimeId: 'claude-code', source: 'environment-override' })
  })
})
