import path from 'node:path'

import { registerModelCapabilities, setProviderModelCapabilities } from '@shared/modelCapabilities'
import { BUILTIN_MODEL_CAPACITY_CATALOG, getModelCatalogCapacity, setModelCapacityCatalog } from '@shared/modelCapacity'
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
  it('uses central capabilities for a renamed model without guessing its family', () => {
    registerModelCapabilities('zen', 'brand-new-alias', {
      context_length: 1_000_000,
      max_input_tokens: 700_000,
      max_output_tokens: 64_000,
      tools: false,
      reasoning: true,
      temperature: false,
      input_modalities: ['text']
    })
    try {
      expect(config('brand-new-alias').provider['zen-selected'].models['brand-new-alias']).toMatchObject({
        tool_call: false,
        reasoning: true,
        temperature: false,
        attachment: false,
        limit: { context: 1_000_000, input: 700_000, output: 64_000 },
        modalities: { input: ['text'] }
      })
    } finally {
      setProviderModelCapabilities('zen', [])
    }
  })
  it('allows native reads of private input material in Plan without granting its parent data directory', () => {
    const inputDirectory = path.resolve('private-native-storage', 'session-hash', 'inputs')
    const built = buildOpenCodeConfig({
      session: { ...session, configuration: { permission_mode: 'plan' } },
      provider: provider('alias'),
      modelId: 'alias',
      skillPaths: [],
      inputDirectory,
      api: { host: '127.0.0.1', port: 3000, apiKey: 'placeholder' }
    })
    expect(built.permission.external_directory[inputDirectory.replaceAll('\\', '/') + '/**']).toBe('allow')
    expect(
      built.permission.external_directory[path.dirname(inputDirectory).replaceAll('\\', '/') + '/**']
    ).toBeUndefined()
    expect(built.permission.edit).toBe('deny')
    expect(built.permission.bash).toBe('deny')
  })
  it('does not inherit system temporary directories or their differently cased aliases', () => {
    const workspaceTemp = path.resolve('工作目录', '.agents', '.tmp', 'session')
    const env = buildOpenCodeEnvironment(
      { TEMP: 'global-temp', Tmp: 'other-temp', tmpdir: 'another-temp', PATH: 'system' },
      path.resolve('isolated'),
      'password',
      undefined,
      undefined,
      workspaceTemp
    )
    expect(env).toMatchObject({ TEMP: workspaceTemp, TMP: workspaceTemp, TMPDIR: workspaceTemp })
    expect(env.Tmp).toBeUndefined()
    expect(env.tmpdir).toBeUndefined()
    expect(Object.values(env)).not.toContain('global-temp')
  })
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
      toolDir,
      'bundled-search'
    )
    expect(env.PATH?.split(path.delimiter)).toEqual(['bundled-search', toolDir, 'system', 'other-system'])
    expect(env.Path).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.OPENCODE_PURE).toBe('false')
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

  it('uses the canonical catalog for a known model, including its separate input limit', () => {
    const capacity = getModelCatalogCapacity('gpt-6.1-sol')!
    const result = config('gpt-6.1-sol')
    expect(result.provider['zen-selected'].models['gpt-6.1-sol'].limit).toEqual({
      context: capacity.context,
      input: capacity.input ?? capacity.context,
      output: capacity.output
    })
    expect((capacity.input ?? capacity.context) - result.compaction.reserved).toBeGreaterThan(800_000)
    expect((capacity.input ?? capacity.context) - result.compaction.reserved).toBeLessThan(capacity.input)
  })

  it('leaves usable space when input capacity is smaller than the allowed output', () => {
    try {
      setModelCapacityCatalog({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        models: { 'test-lab/small-input': { context: 64_000, input: 8_000, output: 32_000 } }
      })
      const result = config('small-input')
      const limits = result.provider['zen-selected'].models['small-input'].limit
      expect(limits).toEqual({ context: 64_000, input: 8_000, output: 32_000 })
      expect(limits.input - result.compaction.reserved).toBe(6_000)
    } finally {
      setModelCapacityCatalog(BUILTIN_MODEL_CAPACITY_CATALOG)
    }
  })

  it.each(['plan', 'default'])(
    'passes large model limits and effective native compaction reserves in %s mode',
    (mode) => {
      const selectedProvider = provider('large-model')
      selectedProvider.models[0].contextWindowTokens = 1_000_000
      selectedProvider.models[0].maxOutputTokens = 128_000
      const result = buildOpenCodeConfig({
        session: { ...session, configuration: { permission_mode: mode } },
        provider: selectedProvider,
        modelId: 'large-model',
        skillPaths: [],
        api: { host: '127.0.0.1', port: 1, apiKey: 'placeholder' }
      })
      expect(result.provider['zen-selected'].models['large-model'].limit).toEqual({
        context: 1_000_000,
        input: 1_000_000,
        output: 128_000
      })
      // v1.19.5's input-limit branch uses reserved; a context/output-only model ignores it.
      expect(result.compaction.reserved).toBe(40_000)
      expect(result.compaction.auto).toBe(true)
      expect(result.compaction.prune).toBe(true)
    }
  )

  it.each([4_000, 16_000])('leaves usable input and bounded recent history for a small %s-token model', (context) => {
    const selectedProvider = provider('small-model')
    selectedProvider.models[0].contextWindowTokens = context
    selectedProvider.models[0].maxOutputTokens = 8_000
    const result = buildOpenCodeConfig({
      session,
      provider: selectedProvider,
      modelId: 'small-model',
      skillPaths: [],
      api: { host: '127.0.0.1', port: 1, apiKey: 'placeholder' }
    })
    const limits = result.provider['zen-selected'].models['small-model'].limit
    expect(limits.input).toBe(context)
    expect(result.compaction.reserved).toBeGreaterThanOrEqual(limits.output)
    expect(limits.input - result.compaction.reserved).toBeGreaterThanOrEqual(768)
    expect(result.compaction.preserve_recent_tokens).toBeLessThan(limits.input - result.compaction.reserved)
  })

  it.each([NaN, Infinity, -1, 0, Number.MAX_VALUE])('uses finite defaults for invalid capacity %s', (value) => {
    const selectedProvider = provider('invalid-model')
    selectedProvider.models[0].contextWindowTokens = value
    selectedProvider.models[0].maxOutputTokens = value
    const result = buildOpenCodeConfig({
      session,
      provider: selectedProvider,
      modelId: 'invalid-model',
      skillPaths: [],
      api: { host: '127.0.0.1', port: 1, apiKey: 'placeholder' }
    })
    expect(result.provider['zen-selected'].models['invalid-model'].limit).toEqual({
      context: 128_000,
      input: 128_000,
      output: 16_000
    })
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
    expect(result.permission['mcp__assistant__literature_search']).toBe('allow')
    expect(result.permission['mcp__assistant__read_paper']).toBe('allow')
    expect(result.permission['mcp__assistant__read_webpage']).toBe('allow')
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
