import type { Assistant, MCPTool, Model, Provider } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/store', () => ({
  default: { getState: () => ({ websearch: { maxResults: 5, excludeDomains: [], searchWithTime: false } }) }
}))
vi.mock('@renderer/services/AssistantService', () => ({
  DEFAULT_ASSISTANT_SETTINGS: { maxToolCalls: 20, enableMaxToolCalls: true },
  getDefaultModel: () => ({ id: 'test-model', name: 'Test', provider: 'openai' })
}))
vi.mock('@renderer/config/models', () => ({
  isAnthropicModel: () => false,
  isFixedReasoningModel: () => false,
  isGeminiModel: () => false,
  isGenerateImageModel: () => false,
  isGrokModel: () => false,
  isOpenAIModel: () => true,
  isOpenRouterBuiltInWebSearchModel: () => false,
  isSupportedReasoningEffortModel: () => false,
  isSupportedThinkingTokenModel: () => false,
  isWebSearchModel: () => false
}))
vi.mock('@renderer/aiCore/provider/factory', () => ({ getAiSdkProviderId: () => 'openai' }))
vi.mock('@renderer/aiCore/utils/options', () => ({
  buildProviderOptions: () => ({ providerOptions: {}, standardParams: {} })
}))
vi.mock('../modelParameters', () => ({
  getMaxTokens: () => undefined,
  getTemperature: () => undefined,
  getTopP: () => undefined
}))
vi.mock('@renderer/utils/prompt', () => ({ replacePromptVariables: async (prompt: string) => prompt }))

import { buildGenerateTextParams, buildStreamTextParams } from '../parameterBuilder'

const model = { id: 'test-model', name: 'Test', provider: 'openai' } as Model
const provider = { id: 'openai', type: 'openai', models: [model] } as Provider
const assistant = { id: 'test', prompt: 'Preserve my conversation instructions.', model, mcpMode: 'auto' } as Assistant
const hubTools: MCPTool[] = ['list', 'inspect', 'invoke', 'exec'].map((name) => ({
  id: `hub_${name}`,
  name,
  serverId: 'hub',
  serverName: 'Hub',
  type: 'mcp',
  inputSchema: { type: 'object', properties: {}, required: [] }
}))

describe('MCP discovery request construction', () => {
  it('sends ordinary chat without discovery instructions or tools when none were loaded', async () => {
    const result = await buildStreamTextParams([], assistant, provider, { mcpTools: [] })
    try {
      expect(result.params.system).toBe(assistant.prompt)
      expect(result.params.tools).toBeUndefined()
    } finally {
      result.idleTimeout.cleanup()
    }
  })

  it('does not add discovery instructions to internal generation or non-Hub tools', async () => {
    const generated = await buildGenerateTextParams([], assistant, provider)
    const directTool = { ...hubTools[0], id: 'search', serverId: 'search' }
    const streamed = await buildStreamTextParams([], assistant, provider, { mcpTools: [directTool] })
    try {
      expect(generated.params.system).toBe(assistant.prompt)
      expect(generated.params.tools).toBeUndefined()
      expect(streamed.params.system).toBe(assistant.prompt)
      expect(Object.keys(streamed.params.tools ?? {})).toEqual(['search'])
    } finally {
      generated.idleTimeout.cleanup()
      streamed.idleTimeout.cleanup()
    }
  })

  it('includes Hub instructions only with real discovery tools, while retaining the user prompt', async () => {
    const result = await buildStreamTextParams([], assistant, provider, { mcpTools: hubTools })
    try {
      expect(result.params.system).toContain(assistant.prompt)
      expect(result.params.system).toContain('Hub MCP Tools')
      expect(result.params.system).toContain('without discovering tools')
      expect(Object.keys(result.params.tools ?? {})).toEqual(hubTools.map((tool) => tool.id))
    } finally {
      result.idleTimeout.cleanup()
    }
  })
})
