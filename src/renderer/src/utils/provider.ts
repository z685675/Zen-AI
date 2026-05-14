import type {
  AnthropicCacheControlSettings,
  AzureOpenAIProvider,
  EndpointType,
  GeminiCacheControlSettings,
  Model,
  ProviderType
} from '@renderer/types'
import { isSystemProvider, type Provider, type SystemProviderId, SystemProviderIds } from '@renderer/types'
import { isAzureOpenAIProvider } from '@shared/aiCore/provider/utils'
import { CLAUDE_SUPPORTED_PROVIDERS } from '@shared/config/providers'

import { getLowerBaseModelName } from './naming'

export const isAzureResponsesEndpoint = (provider: AzureOpenAIProvider) => {
  return provider.apiVersion === 'preview' || provider.apiVersion === 'v1'
}

export const getClaudeSupportedProviders = (providers: Provider[]) => {
  return providers.filter(
    (p) => p.type === 'anthropic' || !!p.anthropicApiHost || CLAUDE_SUPPORTED_PROVIDERS.includes(p.id)
  )
}

export const getAnthropicSupportedProviders = (providers: Provider[]) => {
  return providers.filter(isAnthropicSupportedProvider)
}

export const isAnthropicSupportedProvider = (provider: Provider) => {
  return provider.type === 'anthropic' || !!provider.anthropicApiHost
}

const NOT_SUPPORT_ARRAY_CONTENT_PROVIDERS = [
  'deepseek',
  'baichuan',
  'minimax',
  'xirang',
  'poe',
  'cephalon'
] as const satisfies SystemProviderId[]

/**
 * 判断提供商是否支持 message 的 content 为数组类型。 Only for OpenAI Chat Completions API.
 */
export const isSupportArrayContentProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isNotSupportArrayContent !== true &&
    !NOT_SUPPORT_ARRAY_CONTENT_PROVIDERS.some((pid) => pid === provider.id)
  )
}

const NOT_SUPPORT_DEVELOPER_ROLE_PROVIDERS = ['poe', 'qiniu'] as const satisfies SystemProviderId[]

/**
 * 判断提供商是否支持 developer 作为 message role。 Only for OpenAI API.
 */
export const isSupportDeveloperRoleProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isSupportDeveloperRole === true ||
    (isSystemProvider(provider) && !NOT_SUPPORT_DEVELOPER_ROLE_PROVIDERS.some((pid) => pid === provider.id))
  )
}

const NOT_SUPPORT_STREAM_OPTIONS_PROVIDERS = ['mistral'] as const satisfies SystemProviderId[]

/**
 * 判断提供商是否支持 stream_options 参数。Only for OpenAI API.
 */
export const isSupportStreamOptionsProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isNotSupportStreamOptions !== true &&
    !NOT_SUPPORT_STREAM_OPTIONS_PROVIDERS.some((pid) => pid === provider.id)
  )
}

const NOT_SUPPORT_QWEN3_ENABLE_THINKING_PROVIDER = [
  'ollama',
  'lmstudio',
  'nvidia',
  'gpustack'
] as const satisfies SystemProviderId[]

/**
 * 判断提供商是否支持使用 enable_thinking 参数来控制 Qwen3 等模型的思考。 Only for OpenAI Chat Completions API.
 */
export const isSupportEnableThinkingProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isNotSupportEnableThinking !== true &&
    !NOT_SUPPORT_QWEN3_ENABLE_THINKING_PROVIDER.some((pid) => pid === provider.id)
  )
}

const SUPPORT_SERVICE_TIER_PROVIDERS = [
  SystemProviderIds.openai,
  SystemProviderIds['azure-openai'],
  SystemProviderIds.groq
  // TODO: 等待上游支持aws-bedrock
]

/**
 * 判断提供商是否支持 service_tier 设置
 */
export const isSupportServiceTierProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isSupportServiceTier === true ||
    provider.type === 'azure-openai' ||
    (isSystemProvider(provider) && SUPPORT_SERVICE_TIER_PROVIDERS.some((pid) => pid === provider.id))
  )
}

const NOT_SUPPORT_VERBOSITY_PROVIDERS = ['groq'] as const satisfies SystemProviderId[]

/**
 * Determines whether the provider supports the verbosity option.
 * Only applies to system providers that are not in the exclusion list.
 * @param provider - The provider to check
 * @returns true if the provider supports verbosity, false otherwise
 */
export const isSupportVerbosityProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isNotSupportVerbosity !== true &&
    !NOT_SUPPORT_VERBOSITY_PROVIDERS.some((pid) => pid === provider.id)
  )
}

const SUPPORT_URL_CONTEXT_PROVIDER_TYPES = [
  'gemini',
  'vertexai',
  'anthropic',
  'azure-openai',
  'new-api'
] as const satisfies ProviderType[]

export const isSupportUrlContextProvider = (provider: Provider) => {
  return (
    SUPPORT_URL_CONTEXT_PROVIDER_TYPES.some((type) => type === provider.type) ||
    provider.id === SystemProviderIds.cherryin
  )
}

const SUPPORT_GEMINI_NATIVE_WEB_SEARCH_PROVIDERS = ['gemini', 'vertexai'] as const satisfies SystemProviderId[]

/** 判断是否是使用 Gemini 原生搜索工具的 provider. 目前假设只有官方 API 使用原生工具 */
export const isGeminiWebSearchProvider = (provider: Provider) => {
  return SUPPORT_GEMINI_NATIVE_WEB_SEARCH_PROVIDERS.some((id) => id === provider.id)
}

export const isNewApiProvider = (provider: Provider) => {
  return ['new-api', 'cherryin', 'aionly'].includes(provider.id) || provider.type === 'new-api'
}

/**
 * 判断是否为 OpenAI 兼容的提供商
 * @param {Provider} provider 提供商对象
 * @returns {boolean} 是否为 OpenAI 兼容提供商
 */
export function isOpenAICompatibleProvider(provider: Provider): boolean {
  return ['openai', 'new-api', 'mistral'].includes(provider.type)
}

export function isOpenAIProvider(provider: Provider): boolean {
  return provider.type === 'openai-response'
}

export function isAwsBedrockProvider(provider: Provider): boolean {
  return provider.type === 'aws-bedrock'
}

// Re-export from shared, for backward compatibility
export {
  isAnthropicProvider,
  isAzureOpenAIProvider,
  isCherryAIProvider,
  isGeminiProvider,
  isOllamaProvider,
  isPerplexityProvider,
  isVertexProvider
} from '@shared/aiCore/provider/utils'

export function isAIGatewayProvider(provider: Provider): boolean {
  return provider.type === 'gateway'
}

const NOT_SUPPORT_API_VERSION_PROVIDERS = ['github', 'copilot', 'perplexity'] as const satisfies SystemProviderId[]

export const isSupportAPIVersionProvider = (provider: Provider) => {
  if (isSystemProvider(provider)) {
    return !NOT_SUPPORT_API_VERSION_PROVIDERS.some((pid) => pid === provider.id)
  }
  return provider.apiOptions?.isNotSupportAPIVersion !== false
}

export const NOT_SUPPORT_API_KEY_PROVIDERS: readonly SystemProviderId[] = [
  'ollama',
  'lmstudio',
  'vertexai',
  'aws-bedrock',
  'copilot'
]

export const NOT_SUPPORT_API_KEY_PROVIDER_TYPES: readonly ProviderType[] = ['vertexai', 'aws-bedrock']

// https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration
export const isSupportAnthropicPromptCacheProvider = (provider: Provider) => {
  return (
    provider.type === 'anthropic' ||
    isNewApiProvider(provider) ||
    provider.id === SystemProviderIds.aihubmix ||
    provider.id === SystemProviderIds.openrouter ||
    isAzureOpenAIProvider(provider)
  )
}

function resolveModelEndpointType(model?: Pick<Model, 'endpoint_type'>): EndpointType | undefined {
  return model?.endpoint_type
}

export function getModelCachePathLabel(
  model?: Pick<Model, 'id' | 'endpoint_type'>
): 'OpenAI' | 'Anthropic' | 'Gemini' | undefined {
  const endpointType = resolveModelEndpointType(model as Pick<Model, 'endpoint_type'> | undefined)

  if (endpointType === 'anthropic') {
    return 'Anthropic'
  }

  if (endpointType === 'gemini') {
    return 'Gemini'
  }

  if (endpointType === 'openai' || endpointType === 'openai-response') {
    return 'OpenAI'
  }

  const normalizedModelId = model?.id ? getLowerBaseModelName(model.id).toLowerCase() : ''

  if (normalizedModelId.startsWith('claude') || normalizedModelId.includes('claude')) {
    return 'Anthropic'
  }

  if (
    normalizedModelId.startsWith('gemini') ||
    normalizedModelId.startsWith('google/gemini') ||
    normalizedModelId.includes('gemini')
  ) {
    return 'Gemini'
  }

  if (
    normalizedModelId.startsWith('gpt') ||
    normalizedModelId.startsWith('o1') ||
    normalizedModelId.startsWith('o3') ||
    normalizedModelId.startsWith('o4') ||
    normalizedModelId.startsWith('chatgpt') ||
    normalizedModelId.startsWith('openai/')
  ) {
    return 'OpenAI'
  }

  return undefined
}

const DEFAULT_ANTHROPIC_CACHE_LAST_N_MESSAGES = 1
const DEFAULT_ANTHROPIC_CACHE_SYSTEM_MESSAGE = true
const DEFAULT_GEMINI_CACHE_TTL_SECONDS = 3600
const DEFAULT_GEMINI_CACHE_EARLY_MESSAGES = 2
const DEFAULT_GEMINI_CACHE_SYSTEM_MESSAGE = true

const ANTHROPIC_CACHE_4096_PATTERNS = [
  'claude-opus-4-7',
  'claude-opus-4.7',
  'claude-opus-4-6',
  'claude-opus-4.6',
  'claude-opus-4-5',
  'claude-opus-4.5',
  'claude-haiku-4-5',
  'claude-haiku-4.5',
  'claude-mythos'
]

const ANTHROPIC_CACHE_2048_PATTERNS = [
  'claude-sonnet-4-6',
  'claude-sonnet-4.6',
  'claude-haiku-3-5',
  'claude-haiku-3.5',
  'claude-haiku-3'
]

export const getRecommendedAnthropicCacheThreshold = (model?: Pick<Model, 'id'>): number => {
  const normalizedModelId = model?.id ? getLowerBaseModelName(model.id).toLowerCase() : ''

  if (ANTHROPIC_CACHE_4096_PATTERNS.some((pattern) => normalizedModelId.includes(pattern))) {
    return 4096
  }

  if (ANTHROPIC_CACHE_2048_PATTERNS.some((pattern) => normalizedModelId.includes(pattern))) {
    return 2048
  }

  return 1024
}

export const getEffectiveAnthropicCacheControl = (
  provider: Provider,
  model?: Pick<Model, 'id'>
): AnthropicCacheControlSettings | undefined => {
  const endpointType = resolveModelEndpointType(model as Pick<Model, 'endpoint_type'> | undefined)

  if (endpointType && endpointType !== 'anthropic') {
    return undefined
  }

  if (!endpointType && !isSupportAnthropicPromptCacheProvider(provider)) {
    return undefined
  }

  return {
    tokenThreshold: provider.anthropicCacheControl?.tokenThreshold ?? getRecommendedAnthropicCacheThreshold(model),
    cacheSystemMessage: provider.anthropicCacheControl?.cacheSystemMessage ?? DEFAULT_ANTHROPIC_CACHE_SYSTEM_MESSAGE,
    cacheLastNMessages: provider.anthropicCacheControl?.cacheLastNMessages ?? DEFAULT_ANTHROPIC_CACHE_LAST_N_MESSAGES
  }
}

export const getRecommendedGeminiCacheThreshold = (model?: Pick<Model, 'id'>): number => {
  const normalizedModelId = model?.id ? getLowerBaseModelName(model.id).toLowerCase() : ''

  if (normalizedModelId.includes('gemini-2.5-pro') || normalizedModelId.includes('gemini-3-pro')) {
    return 4096
  }

  return 2048
}

export const isSupportGeminiPromptCacheProvider = (provider: Provider) => {
  return provider.type === 'gemini'
}

export const getEffectiveGeminiCacheControl = (
  provider: Provider,
  model?: Pick<Model, 'id'>
): GeminiCacheControlSettings | undefined => {
  const endpointType = resolveModelEndpointType(model as Pick<Model, 'endpoint_type'> | undefined)

  if (endpointType && endpointType !== 'gemini') {
    return undefined
  }

  if (!endpointType && !isSupportGeminiPromptCacheProvider(provider)) {
    return undefined
  }

  const providerSettings = provider.geminiCacheControl
  const enabled = providerSettings?.enabled ?? true

  if (!enabled) {
    return undefined
  }

  return {
    enabled,
    tokenThreshold: providerSettings?.tokenThreshold ?? getRecommendedGeminiCacheThreshold(model),
    cacheSystemMessage: providerSettings?.cacheSystemMessage ?? DEFAULT_GEMINI_CACHE_SYSTEM_MESSAGE,
    cacheEarlyMessages: providerSettings?.cacheEarlyMessages ?? DEFAULT_GEMINI_CACHE_EARLY_MESSAGES,
    ttlSeconds: providerSettings?.ttlSeconds ?? DEFAULT_GEMINI_CACHE_TTL_SECONDS
  }
}
