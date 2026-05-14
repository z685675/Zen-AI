import { type AzureOpenAIProvider, type Provider, SystemProviderIds } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

import {
  getAnthropicSupportedProviders,
  getClaudeSupportedProviders,
  getEffectiveAnthropicCacheControl,
  getEffectiveGeminiCacheControl,
  getRecommendedAnthropicCacheThreshold,
  getRecommendedGeminiCacheThreshold,
  isAIGatewayProvider,
  isAnthropicProvider,
  isAnthropicSupportedProvider,
  isAzureOpenAIProvider,
  isCherryAIProvider,
  isGeminiProvider,
  isGeminiWebSearchProvider,
  isNewApiProvider,
  isOpenAICompatibleProvider,
  isOpenAIProvider,
  isPerplexityProvider,
  isSupportAnthropicPromptCacheProvider,
  isSupportAPIVersionProvider,
  isSupportArrayContentProvider,
  isSupportDeveloperRoleProvider,
  isSupportEnableThinkingProvider,
  isSupportGeminiPromptCacheProvider,
  isSupportServiceTierProvider,
  isSupportStreamOptionsProvider,
  isSupportUrlContextProvider,
  isSupportVerbosityProvider
} from '../provider'

vi.mock('@renderer/store/settings', () => ({
  default: (state = { settings: {} }) => state
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getProviderByModel: vi.fn(),
  getAssistantSettings: vi.fn(),
  getDefaultAssistant: vi.fn().mockReturnValue({
    id: 'default',
    name: 'Default Assistant',
    prompt: '',
    settings: {}
  })
}))

const createProvider = (overrides: Partial<Provider> = {}): Provider => ({
  id: 'custom',
  type: 'openai',
  name: 'Custom Provider',
  apiKey: 'key',
  apiHost: 'https://api.example.com',
  models: [],
  ...overrides
})

const createSystemProvider = (overrides: Partial<Provider> = {}): Provider =>
  createProvider({
    id: SystemProviderIds.openai,
    isSystem: true,
    ...overrides
  })

describe('provider utils', () => {
  it('filters Claude supported providers', () => {
    const providers = [
      createProvider({ id: 'anthropic-official', type: 'anthropic' }),
      createProvider({ id: 'custom-host', anthropicApiHost: 'https://anthropic.local' }),
      createProvider({ id: 'aihubmix' }),
      createProvider({ id: 'other' })
    ]

    expect(getClaudeSupportedProviders(providers)).toEqual(providers.slice(0, 3))
  })

  it('filters Anthropic supported providers', () => {
    const providers = [
      createProvider({ id: 'anthropic-official', type: 'anthropic' }),
      createProvider({ id: 'custom-host', anthropicApiHost: 'https://anthropic.local' }),
      createProvider({ id: 'aihubmix' }),
      createProvider({ id: 'other' })
    ]

    expect(getAnthropicSupportedProviders(providers)).toEqual(providers.slice(0, 2))
  })

  it('checks Anthropic supported provider', () => {
    expect(isAnthropicSupportedProvider(createProvider({ id: 'anthropic-official', type: 'anthropic' }))).toBe(true)
    expect(
      isAnthropicSupportedProvider(createProvider({ id: 'custom-host', anthropicApiHost: 'https://anthropic.local' }))
    ).toBe(true)
    expect(isAnthropicSupportedProvider(createProvider({ id: 'aihubmix' }))).toBe(false)
    expect(isAnthropicSupportedProvider(createProvider({ id: 'other' }))).toBe(false)
  })

  it('detects Anthropic prompt cache support', () => {
    expect(isSupportAnthropicPromptCacheProvider(createProvider({ type: 'anthropic' }))).toBe(true)
    expect(isSupportAnthropicPromptCacheProvider(createProvider({ id: SystemProviderIds['new-api'], type: 'new-api' }))).toBe(
      true
    )
    expect(isSupportAnthropicPromptCacheProvider(createProvider({ id: SystemProviderIds.openrouter }))).toBe(true)
    expect(isSupportAnthropicPromptCacheProvider(createProvider())).toBe(false)
  })

  it('recommends cache thresholds by Claude model family', () => {
    expect(getRecommendedAnthropicCacheThreshold({ id: 'claude-sonnet-4-20250514' } as any)).toBe(1024)
    expect(getRecommendedAnthropicCacheThreshold({ id: 'claude-sonnet-4-6' } as any)).toBe(2048)
    expect(getRecommendedAnthropicCacheThreshold({ id: 'claude-opus-4-5-20251101' } as any)).toBe(4096)
  })

  it('builds effective Anthropic cache defaults for supported providers', () => {
    expect(getEffectiveAnthropicCacheControl(createProvider())).toBeUndefined()

    expect(getEffectiveAnthropicCacheControl(createProvider({ type: 'anthropic' }), { id: 'claude-sonnet-4-6' } as any)).toEqual({
      tokenThreshold: 2048,
      cacheSystemMessage: true,
      cacheLastNMessages: 1
    })

    expect(
      getEffectiveAnthropicCacheControl(
        createProvider({
          type: 'anthropic',
          anthropicCacheControl: {
            tokenThreshold: 0,
            cacheSystemMessage: false,
            cacheLastNMessages: 3
          }
        }),
        { id: 'claude-opus-4-5' } as any
      )
    ).toEqual({
      tokenThreshold: 0,
      cacheSystemMessage: false,
      cacheLastNMessages: 3
    })

    expect(
      getEffectiveAnthropicCacheControl(
        createProvider({
          id: SystemProviderIds['new-api'],
          type: 'new-api'
        }),
        { id: 'claude-sonnet-4-6', endpoint_type: 'anthropic' } as any
      )
    ).toEqual({
      tokenThreshold: 2048,
      cacheSystemMessage: true,
      cacheLastNMessages: 1
    })
  })

  it('detects Gemini prompt cache support and computes effective defaults', () => {
    expect(isSupportGeminiPromptCacheProvider(createProvider({ type: 'gemini' }))).toBe(true)
    expect(isSupportGeminiPromptCacheProvider(createProvider({ type: 'vertexai' }))).toBe(false)
    expect(getRecommendedGeminiCacheThreshold({ id: 'gemini-2.5-pro' } as any)).toBe(4096)
    expect(getRecommendedGeminiCacheThreshold({ id: 'gemini-2.5-flash' } as any)).toBe(2048)
    expect(getEffectiveGeminiCacheControl(createProvider())).toBeUndefined()

    expect(getEffectiveGeminiCacheControl(createProvider({ type: 'gemini' }), { id: 'gemini-2.5-pro' } as any)).toEqual({
      enabled: true,
      tokenThreshold: 4096,
      cacheSystemMessage: true,
      cacheEarlyMessages: 2,
      ttlSeconds: 3600
    })

    expect(
      getEffectiveGeminiCacheControl(
        createProvider({
          type: 'gemini',
          geminiCacheControl: {
            enabled: true,
            tokenThreshold: 3000,
            cacheSystemMessage: false,
            cacheEarlyMessages: 3,
            ttlSeconds: 1800
          }
        }),
        { id: 'gemini-2.5-pro' } as any
      )
    ).toEqual({
      enabled: true,
      tokenThreshold: 3000,
      cacheSystemMessage: false,
      cacheEarlyMessages: 3,
      ttlSeconds: 1800
    })

    expect(
      getEffectiveGeminiCacheControl(
        createProvider({
          id: SystemProviderIds['new-api'],
          type: 'new-api'
        }),
        { id: 'gemini-2.5-pro', endpoint_type: 'gemini' } as any
      )
    ).toEqual({
      enabled: true,
      tokenThreshold: 4096,
      cacheSystemMessage: true,
      cacheEarlyMessages: 2,
      ttlSeconds: 3600
    })
  })

  it('evaluates message array content support', () => {
    expect(isSupportArrayContentProvider(createProvider())).toBe(true)

    expect(isSupportArrayContentProvider(createProvider({ apiOptions: { isNotSupportArrayContent: true } }))).toBe(
      false
    )

    expect(isSupportArrayContentProvider(createSystemProvider({ id: SystemProviderIds.deepseek }))).toBe(false)
  })

  it('evaluates developer role support', () => {
    expect(isSupportDeveloperRoleProvider(createProvider({ apiOptions: { isSupportDeveloperRole: true } }))).toBe(true)
    expect(isSupportDeveloperRoleProvider(createSystemProvider())).toBe(true)
    expect(isSupportDeveloperRoleProvider(createSystemProvider({ id: SystemProviderIds.poe }))).toBe(false)
  })

  it('checks stream options support', () => {
    expect(isSupportStreamOptionsProvider(createProvider())).toBe(true)
    expect(isSupportStreamOptionsProvider(createProvider({ apiOptions: { isNotSupportStreamOptions: true } }))).toBe(
      false
    )
    expect(isSupportStreamOptionsProvider(createSystemProvider({ id: SystemProviderIds.mistral }))).toBe(false)
  })

  it('checks enable thinking support', () => {
    expect(isSupportEnableThinkingProvider(createProvider())).toBe(true)
    expect(isSupportEnableThinkingProvider(createProvider({ apiOptions: { isNotSupportEnableThinking: true } }))).toBe(
      false
    )
    expect(isSupportEnableThinkingProvider(createSystemProvider({ id: SystemProviderIds.nvidia }))).toBe(false)
  })

  it('determines service tier support', () => {
    expect(isSupportServiceTierProvider(createProvider({ apiOptions: { isSupportServiceTier: true } }))).toBe(true)
    expect(isSupportServiceTierProvider(createSystemProvider())).toBe(true)
    expect(isSupportServiceTierProvider(createSystemProvider({ id: SystemProviderIds.github }))).toBe(false)
  })

  it('determines verbosity support', () => {
    // Custom providers with explicit flag
    expect(isSupportVerbosityProvider(createProvider({ apiOptions: { isNotSupportVerbosity: false } }))).toBe(true)
    expect(isSupportVerbosityProvider(createProvider({ apiOptions: { isNotSupportVerbosity: true } }))).toBe(false)

    // Custom providers without apiOptions (should support by default)
    expect(isSupportVerbosityProvider(createProvider())).toBe(true)
    expect(isSupportVerbosityProvider(createProvider({ apiOptions: {} }))).toBe(true)

    // System providers that support verbosity (default behavior)
    expect(isSupportVerbosityProvider(createSystemProvider())).toBe(true)
    expect(isSupportVerbosityProvider(createSystemProvider({ id: SystemProviderIds.openai }))).toBe(true)

    // System providers in the NOT_SUPPORT_VERBOSITY_PROVIDERS list (cannot be overridden by apiOptions)
    expect(isSupportVerbosityProvider(createSystemProvider({ id: SystemProviderIds.groq }))).toBe(false)
    expect(
      isSupportVerbosityProvider(
        createSystemProvider({ id: SystemProviderIds.groq, apiOptions: { isNotSupportVerbosity: false } })
      )
    ).toBe(false)

    // apiOptions can disable verbosity for any provider
    expect(
      isSupportVerbosityProvider(
        createSystemProvider({ id: SystemProviderIds.openai, apiOptions: { isNotSupportVerbosity: true } })
      )
    ).toBe(false)
  })

  it('detects URL context capable providers', () => {
    expect(isSupportUrlContextProvider(createProvider({ type: 'gemini' }))).toBe(true)
    expect(
      isSupportUrlContextProvider(
        createSystemProvider({ id: SystemProviderIds.cherryin, type: 'openai', isSystem: true })
      )
    ).toBe(true)
    expect(isSupportUrlContextProvider(createProvider())).toBe(false)
  })

  it('identifies Gemini web search providers', () => {
    expect(isGeminiWebSearchProvider(createSystemProvider({ id: SystemProviderIds.gemini, type: 'gemini' }))).toBe(true)
    expect(isGeminiWebSearchProvider(createSystemProvider({ id: SystemProviderIds.vertexai, type: 'vertexai' }))).toBe(
      true
    )
    expect(isGeminiWebSearchProvider(createSystemProvider())).toBe(false)
  })

  it('detects New API providers by id or type', () => {
    expect(isNewApiProvider(createProvider({ id: SystemProviderIds['new-api'] }))).toBe(true)
    expect(isNewApiProvider(createProvider({ id: SystemProviderIds.cherryin }))).toBe(true)
    expect(isNewApiProvider(createProvider({ type: 'new-api' }))).toBe(true)
    expect(isNewApiProvider(createProvider())).toBe(false)
  })

  it('detects specific provider ids', () => {
    expect(isCherryAIProvider(createProvider({ id: 'cherryai' }))).toBe(true)
    expect(isCherryAIProvider(createProvider())).toBe(false)

    expect(isPerplexityProvider(createProvider({ id: SystemProviderIds.perplexity }))).toBe(true)
    expect(isPerplexityProvider(createProvider())).toBe(false)
  })

  it('recognizes OpenAI compatible providers', () => {
    expect(isOpenAICompatibleProvider(createProvider({ type: 'openai' }))).toBe(true)
    expect(isOpenAICompatibleProvider(createProvider({ type: 'new-api' }))).toBe(true)
    expect(isOpenAICompatibleProvider(createProvider({ type: 'mistral' }))).toBe(true)
    expect(isOpenAICompatibleProvider(createProvider({ type: 'anthropic' }))).toBe(false)
  })

  it('narrows Azure OpenAI providers', () => {
    const azureProvider = {
      ...createProvider({ type: 'azure-openai' }),
      apiVersion: '2024-06-01'
    } as AzureOpenAIProvider
    expect(isAzureOpenAIProvider(azureProvider)).toBe(true)
    expect(isAzureOpenAIProvider(createProvider())).toBe(false)
  })

  it('checks provider type helpers', () => {
    expect(isOpenAIProvider(createProvider({ type: 'openai-response' }))).toBe(true)
    expect(isOpenAIProvider(createProvider())).toBe(false)

    expect(isAnthropicProvider(createProvider({ type: 'anthropic' }))).toBe(true)
    expect(isGeminiProvider(createProvider({ type: 'gemini' }))).toBe(true)
    expect(isAIGatewayProvider(createProvider({ type: 'gateway' }))).toBe(true)
  })

  it('computes API version support', () => {
    expect(isSupportAPIVersionProvider(createSystemProvider())).toBe(true)
    expect(isSupportAPIVersionProvider(createSystemProvider({ id: SystemProviderIds.github }))).toBe(false)
    expect(isSupportAPIVersionProvider(createProvider())).toBe(true)
    expect(isSupportAPIVersionProvider(createProvider({ apiOptions: { isNotSupportAPIVersion: false } }))).toBe(false)
  })
})
