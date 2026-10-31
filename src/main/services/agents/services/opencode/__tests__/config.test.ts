import path from 'node:path'

import type { GetAgentSessionResponse, Provider } from '@types'
import { describe, expect, it } from 'vitest'

import { buildOpenCodeConfig, buildOpenCodeEnvironment } from '../config'

const session = {
  id: 'session-new',
  accessible_paths: [path.resolve('workspace')],
  configuration: {}
} as GetAgentSessionResponse
const provider = (id: string, type = 'new-api', endpoint_type?: string) =>
  ({
    id: 'zen',
    type,
    apiHost: 'https://gateway.example/v1',
    apiKey: 'placeholder',
    models: [{ id, name: id, endpoint_type }]
  }) as Provider
const config = (id: string, type = 'new-api', endpoint?: string) =>
  buildOpenCodeConfig({
    session,
    provider: provider(id, type, endpoint),
    modelId: id,
    skillPaths: [],
    api: { host: '0.0.0.0', port: 3000, apiKey: 'mcp-placeholder' }
  })

describe('OpenCode isolated model config', () => {
  it('gives slow response headers time within a finite whole-request and idle-chunk budget', () => {
    expect(config('alias').provider['zen-selected'].options).toMatchObject({
      timeout: 600_000,
      headerTimeout: 120_000,
      chunkTimeout: 120_000
    })
  })
  it('exposes automatically prepared tools without inspecting or installing them on task startup', () => {
    const toolDir = path.resolve('owned-tools')
    const env = buildOpenCodeEnvironment(
      { Path: ['system', toolDir].join(path.delimiter), PATH: 'other-system', OPENAI_API_KEY: 'private' },
      path.resolve('isolated'),
      'password',
      toolDir
    )
    expect(env.PATH?.split(path.delimiter)).toEqual([toolDir, 'system', 'other-system'])
    expect(env.Path).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.OPENCODE_PURE).toBe('true')
  })
  it.each(['gpt-6-sol', 'claude-sonnet-5', 'gemini-3-pro', 'grok-4'])(
    'uses the gateway protocol, not model name, for %s',
    (model) => {
      const result = config(model)
      expect(result.provider['zen-selected'].npm).toBe('@ai-sdk/openai-compatible')
      expect(result.provider['zen-selected'].models[model].id).toBe(model)
      expect(result.enabled_providers).toEqual(['zen-selected'])
    }
  )
  it.each([
    ['gemini', '@ai-sdk/google'],
    ['anthropic', '@ai-sdk/anthropic'],
    ['openai-response', '@ai-sdk/openai']
  ])('maps declared %s endpoints', (endpoint, npm) => {
    expect(config('alias', 'new-api', endpoint).provider['zen-selected'].npm).toBe(npm)
  })
  it('has a finite native compaction budget even for a new model alias', () => {
    const result = config('future-model')
    expect(result.provider['zen-selected'].models['future-model'].limit.context).toBe(128_000)
    expect(result.compaction.auto).toBe(true)
    expect(result.compaction.prune).toBe(true)
    expect(result.attachment.image).toEqual({
      auto_resize: true,
      max_width: 2000,
      max_height: 2000,
      max_base64_bytes: 5 * 1024 * 1024
    })
    expect(result.provider['zen-selected'].models['future-model'].modalities.input).not.toContain('pdf')
    expect(result.agent.title.disable).toBe(true)
    expect(result.plugin).toEqual([])
    expect(result.provider['zen-selected'].options.headers.Originator).toBe('zenai_opencode')
  })
  it('retains exact Office Skill MCP names, loopback auth and disables OAuth', () => {
    const result = config('gpt-6-sol')
    expect(result.mcp.mcp__assistant_.url).toBe('http://127.0.0.1:3000/v1/assistant/session-new/mcp')
    expect(result.mcp.mcp__assistant_.oauth).toBe(false)
    expect(result.mcp.mcp__browser_.timeout).toBe(15 * 60_000)
    expect(`${'mcp__assistant_'}_${'create_file'}`).toBe('mcp__assistant__create_file')
  })
  it('denies mutating tools in plan mode', () => {
    const result = buildOpenCodeConfig({
      session: { ...session, configuration: { permission_mode: 'plan' } },
      provider: provider('alias'),
      modelId: 'alias',
      skillPaths: [],
      api: { host: '127.0.0.1', port: 1, apiKey: 'placeholder' }
    })
    expect(result.permission.edit).toBe('deny')
    expect(result.permission.bash).toBe('deny')
    expect(result.permission['mcp__assistant_*']).toBe('deny')
    expect(result.permission['mcp__assistant__web_search']).toBe('allow')
    expect(result.permission['mcp__assistant__environment']).toBe('allow')
    expect(result.permission['mcp__assistant__skill_status']).toBe('allow')
    expect(result.permission['mcp__assistant__read_document']).toBe('allow')
  })
  it.each([undefined, 'default', 'acceptEdits', 'bypassPermissions'] as const)(
    'inherits native Build defaults for %s while preserving deletion and path approval',
    (permissionMode) => {
      const result = buildOpenCodeConfig({
        session: { ...session, configuration: { permission_mode: permissionMode } },
        provider: provider('alias'),
        modelId: 'alias',
        skillPaths: [],
        api: { host: '127.0.0.1', port: 1, apiKey: 'placeholder' }
      })
      expect(result.permission['*']).toBeUndefined()
      expect(result.permission.read).toBeUndefined()
      expect(result.permission.edit).toBeUndefined()
      expect(result.permission.external_directory).toMatchObject({ '*': 'ask' })
      expect(result.permission.bash).toMatchObject({
        '*': 'allow',
        'rm *': 'ask',
        'Remove-Item *': 'ask',
        'del *': 'ask'
      })
      expect(result.permission['mcp__assistant_*']).toBe('allow')
      expect(result.snapshot).toBe(false)
    }
  )
  it('does not inherit personal provider credentials, accounts or unsafe runtime options', () => {
    const env = buildOpenCodeEnvironment(
      {
        PATH: 'approved',
        OPENAI_API_KEY: 'private',
        ANTHROPIC_API_KEY: 'private',
        OPENCODE_CONFIG_CONTENT: 'private',
        NODE_OPTIONS: 'unsafe',
        AWS_SECRET_ACCESS_KEY: 'private',
        HTTPS_PROXY: 'http://proxy:8080'
      },
      path.resolve('isolated'),
      'owned-password'
    )
    expect(env.PATH).toBe('approved')
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe('true')
    expect(env.OPENCODE_CONFIG_DIR).toBe(path.resolve('isolated', 'config', 'opencode'))
    expect(env.NO_PROXY).toContain('127.0.0.1')
  })
})
