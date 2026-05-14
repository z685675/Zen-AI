import type { Assistant, Model, Provider } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

import { buildPlugins } from '../PluginBuilder'

vi.mock('@renderer/hooks/useSettings', () => ({
  getEnableDeveloperMode: () => false
}))

const createProvider = (overrides: Partial<Provider> = {}): Provider =>
  ({
    id: 'anthropic',
    type: 'anthropic',
    name: 'Anthropic',
    apiKey: 'key',
    apiHost: 'https://api.anthropic.com',
    models: [],
    ...overrides
  }) as Provider

const createModel = (overrides: Partial<Model> = {}): Model =>
  ({
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    ...overrides
  }) as Model

const createAssistant = (): Assistant =>
  ({
    id: 'assistant-1',
    name: 'Assistant',
    prompt: '',
    type: 'assistant',
    topics: [],
    messages: [],
    regularPhrases: [],
    settings: {
      contextCount: 10,
      streamOutput: true
    }
  }) as Assistant

describe('PluginBuilder', () => {
  it('adds anthropic cache plugin from effective defaults for supported providers', () => {
    const plugins = buildPlugins({
      provider: createProvider(),
      model: createModel(),
      config: {
        assistant: createAssistant(),
        streamOutput: true,
        enableReasoning: false,
        isPromptToolUse: false,
        isSupportedToolUse: false,
        enableWebSearch: false,
        enableGenerateImage: false,
        enableUrlContext: false
      }
    })

    expect(plugins.some((plugin) => plugin.name === 'anthropicCache')).toBe(true)
  })

  it('respects explicit cache disable settings', () => {
    const plugins = buildPlugins({
      provider: createProvider({
        anthropicCacheControl: {
          tokenThreshold: 0,
          cacheSystemMessage: true,
          cacheLastNMessages: 1
        }
      }),
      model: createModel(),
      config: {
        assistant: createAssistant(),
        streamOutput: true,
        enableReasoning: false,
        isPromptToolUse: false,
        isSupportedToolUse: false,
        enableWebSearch: false,
        enableGenerateImage: false,
        enableUrlContext: false
      }
    })

    expect(plugins.some((plugin) => plugin.name === 'anthropicCache')).toBe(false)
  })

  it('adds gemini cache plugin from effective defaults for supported providers', () => {
    const plugins = buildPlugins({
      provider: createProvider({
        id: 'gemini',
        type: 'gemini'
      }),
      model: createModel({
        id: 'gemini-2.5-pro',
        provider: 'gemini'
      }),
      config: {
        assistant: createAssistant(),
        streamOutput: true,
        enableReasoning: false,
        isPromptToolUse: false,
        isSupportedToolUse: false,
        enableWebSearch: false,
        enableGenerateImage: false,
        enableUrlContext: false
      }
    })

    expect(plugins.some((plugin) => plugin.name === 'geminiCache')).toBe(true)
  })

  it('adds anthropic cache plugin for new-api providers when model endpoint_type is anthropic', () => {
    const plugins = buildPlugins({
      provider: createProvider({
        id: 'new-api',
        type: 'new-api'
      }),
      model: createModel({
        id: 'claude-sonnet-4-6',
        provider: 'new-api',
        endpoint_type: 'anthropic'
      }),
      config: {
        assistant: createAssistant(),
        streamOutput: true,
        enableReasoning: false,
        isPromptToolUse: false,
        isSupportedToolUse: false,
        enableWebSearch: false,
        enableGenerateImage: false,
        enableUrlContext: false
      }
    })

    expect(plugins.some((plugin) => plugin.name === 'anthropicCache')).toBe(true)
  })

  it('adds gemini cache plugin for new-api providers when model endpoint_type is gemini', () => {
    const plugins = buildPlugins({
      provider: createProvider({
        id: 'new-api',
        type: 'new-api'
      }),
      model: createModel({
        id: 'gemini-2.5-pro',
        provider: 'new-api',
        endpoint_type: 'gemini'
      }),
      config: {
        assistant: createAssistant(),
        streamOutput: true,
        enableReasoning: false,
        isPromptToolUse: false,
        isSupportedToolUse: false,
        enableWebSearch: false,
        enableGenerateImage: false,
        enableUrlContext: false
      }
    })

    expect(plugins.some((plugin) => plugin.name === 'geminiCache')).toBe(true)
  })
})
