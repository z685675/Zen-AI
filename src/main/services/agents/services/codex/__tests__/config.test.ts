import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { GetAgentSessionResponse } from '@types'
import { describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('fs')
vi.unmock('node:fs/promises')
vi.unmock('fs/promises')
vi.unmock('node:path')
vi.unmock('path')

import { buildCodexEnv, buildCodexInvocationConfig, buildCodexMcpServers, prepareCodexInput } from '../config'

const baseSession = {
  id: 'session-1',
  agent_id: 'agent-1',
  agent_type: 'claude-code',
  name: 'Session',
  accessible_paths: ['C:\\work', 'D:\\docs'],
  model: 'openai:gpt-5.1-codex',
  mcps: [],
  allowed_tools: [],
  configuration: {
    permission_mode: 'default',
    env_vars: {
      FOO: 'bar',
      CODEX_API_KEY: 'blocked'
    }
  },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z'
} as unknown as GetAgentSessionResponse

describe('buildCodexEnv', () => {
  it('merges safe user env vars while blocking runtime-critical overrides', () => {
    const env = buildCodexEnv(
      {
        PATH: 'C:\\bin',
        CODEX_API_KEY: 'external-codex-key',
        OPENAI_API_KEY: 'external-openai-key',
        OPENAI_API_BASE: 'http://127.0.0.1:7899/v1',
        OPENAI_BASE_URL: 'http://127.0.0.1:7899/v1'
      },
      {
        FOO: 'bar',
        CODEX_API_KEY: 'blocked',
        NODE_OPTIONS: '--inspect',
        ZEN_AGENT_MCP_API_KEY: 'blocked',
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'unknown-client'
      }
    )

    expect(env.PATH).toBe('C:\\bin')
    expect(env.FOO).toBe('bar')
    expect(env.CODEX_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_BASE).toBeUndefined()
    expect(env.OPENAI_BASE_URL).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.ZEN_AGENT_MCP_API_KEY).toBeUndefined()
    expect(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBe('codex_cli_rs')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})

describe('buildCodexInvocationConfig', () => {
  it('builds Codex client and thread options from session/provider config', () => {
    const config = buildCodexInvocationConfig({
      session: baseSession,
      provider: {
        id: 'openai',
        type: 'openai',
        apiKey: 'sk-test',
        apiHost: 'https://api.openai.com/v1'
      },
      modelId: 'gpt-5.1-codex',
      cwd: 'C:\\work',
      baseEnv: { PATH: 'C:\\bin' },
      codexExecutablePath: 'C:\\codex\\bin\\codex.exe',
      codexPathDirs: ['C:\\codex\\codex-path'],
      thinkingOptions: { effort: 'max' }
    })

    expect(config.clientOptions).toMatchObject({
      codexPathOverride: 'C:\\codex\\bin\\codex.exe',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      env: {
        PATH: ['C:\\codex\\codex-path', 'C:\\bin'].join(path.delimiter),
        FOO: 'bar',
        ELECTRON_RUN_AS_NODE: '1'
      },
      config: {
        model_provider: 'zen-ai-selected-provider',
        model_providers: {
          'zen-ai-selected-provider': {
            name: 'Zen AI selected Provider',
            base_url: 'https://api.openai.com/v1',
            env_key: 'CODEX_API_KEY',
            wire_api: 'responses',
            requires_openai_auth: false,
            supports_websockets: false
          }
        },
        show_raw_agent_reasoning: true,
        sandbox_workspace_write: {
          network_access: true
        }
      }
    })
    expect(config.threadOptions).toMatchObject({
      model: 'gpt-5.1-codex',
      sandboxMode: 'workspace-write',
      workingDirectory: 'C:\\work',
      skipGitRepoCheck: true,
      modelReasoningEffort: 'xhigh',
      networkAccessEnabled: true,
      webSearchMode: 'live',
      approvalPolicy: 'on-request',
      additionalDirectories: ['D:\\docs']
    })
  })

  it('uses danger-full-access when the existing session permission bypass is enabled', () => {
    const config = buildCodexInvocationConfig({
      session: {
        ...baseSession,
        configuration: {
          permission_mode: 'bypassPermissions'
        }
      } as unknown as GetAgentSessionResponse,
      provider: {
        id: 'openai',
        type: 'new-api',
        apiHost: 'https://example.com/v1',
        models: [{ id: 'gpt-5.1-codex', endpoint_type: 'openai-response' }]
      },
      modelId: 'gpt-5.1-codex',
      cwd: 'C:\\work',
      baseEnv: {}
    })

    expect(config.clientOptions.apiKey).toBe('openai')
    expect(config.threadOptions.sandboxMode).toBe('danger-full-access')
    expect(config.threadOptions.approvalPolicy).toBe('never')
  })

  it('accepts common OpenAI-compatible provider types for Codex runtime testing', () => {
    expect(() =>
      buildCodexInvocationConfig({
        session: baseSession,
        provider: {
          id: 'azure',
          type: 'azure-openai',
          apiHost: 'https://example.com/v1'
        },
        modelId: 'gpt-5.1-codex',
        cwd: 'C:\\work',
        baseEnv: {}
      })
    ).not.toThrow()
  })

  it('allows providers with unknown protocol capability to reach a real compatibility attempt', () => {
    expect(() =>
      buildCodexInvocationConfig({
        session: baseSession,
        provider: {
          type: 'anthropic',
          apiHost: 'https://example.com/v1'
        },
        modelId: 'claude-sonnet',
        cwd: 'C:\\work',
        baseEnv: {}
      })
    ).not.toThrow()
  })

  it('rejects providers only when endpoint metadata explicitly excludes OpenAI protocols', () => {
    expect(() =>
      buildCodexInvocationConfig({
        session: baseSession,
        provider: {
          type: 'new-api',
          apiHost: 'https://example.com/v1',
          models: [{ id: 'claude-sonnet', supported_endpoint_types: ['anthropic'] }]
        },
        modelId: 'claude-sonnet',
        cwd: 'C:\\work',
        baseEnv: {}
      })
    ).toThrow('explicitly excludes the OpenAI or OpenAI Responses protocol')
  })

  it('allows mixed gateways without endpoint metadata as an unverified attempt', () => {
    expect(() =>
      buildCodexInvocationConfig({
        session: baseSession,
        provider: {
          id: 'new-api',
          type: 'new-api',
          apiHost: 'https://example.com/v1',
          models: [{ id: 'gpt-5.1-codex' }]
        },
        modelId: 'gpt-5.1-codex',
        cwd: 'C:\\work',
        baseEnv: {}
      })
    ).not.toThrow()
  })

  it('refuses to fall back to a global Codex Provider when the selected Provider has no URL', () => {
    expect(() =>
      buildCodexInvocationConfig({
        session: baseSession,
        provider: {
          id: 'missing-url',
          type: 'openai'
        },
        modelId: 'gpt-5.1-codex',
        cwd: 'C:\\work',
        baseEnv: {
          OPENAI_BASE_URL: 'http://127.0.0.1:7899/v1'
        }
      })
    ).toThrow('has no API URL')
  })
})

describe('buildCodexMcpServers', () => {
  it('maps selected MCP servers to the local authenticated HTTP bridge', () => {
    expect(buildCodexMcpServers(['filesystem.main', 'research'], { host: '127.0.0.1', port: 23333 })).toEqual({
      filesystem_main: {
        url: 'http://127.0.0.1:23333/v1/mcps/filesystem.main/mcp',
        bearer_token_env_var: 'ZEN_AGENT_MCP_API_KEY'
      },
      research: {
        url: 'http://127.0.0.1:23333/v1/mcps/research/mcp',
        bearer_token_env_var: 'ZEN_AGENT_MCP_API_KEY'
      }
    })
  })
})

describe('prepareCodexInput', () => {
  it('returns plain text when no images are provided', async () => {
    const prepared = await prepareCodexInput('hello')
    expect(prepared.input).toBe('hello')
    await expect(prepared.cleanup()).resolves.toBeUndefined()
  })

  it('writes base64 images to temporary local files for Codex CLI input', async () => {
    const prepared = await prepareCodexInput('describe', [
      {
        data: Buffer.from('fake png').toString('base64'),
        media_type: 'image/png'
      }
    ])

    const input = prepared.input as Array<{ type: string; text?: string; path?: string }>
    expect(input[0]).toEqual({ type: 'text', text: 'describe' })
    expect(input[1].type).toBe('local_image')
    expect(input[1].path).toMatch(/image-1\.png$/)
    await expect(readFile(input[1].path!)).resolves.toEqual(Buffer.from('fake png'))

    await prepared.cleanup()
    await expect(readFile(input[1].path!)).rejects.toThrow()
  })
})
