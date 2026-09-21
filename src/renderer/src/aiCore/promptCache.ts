/**
 * Utilities for keeping prompt-cache requests compatible with both native
 * OpenAI SDK providers and OpenAI-compatible providers.
 *
 * Native OpenAI SDK providers accept `promptCacheKey` in providerOptions and
 * serialize it as `prompt_cache_key`. The generic OpenAI-compatible adapter
 * forwards unknown provider options as-is, so it must receive the snake_case
 * field directly.
 */

import type { JSONValue } from 'ai'

export type PromptCacheProviderOptions = Record<string, Record<string, JSONValue | undefined>>

export interface PromptCacheAttachmentContext {
  runtimeProviderId: string
  actualProviderId: string
  modelId: string
  modelEndpointType?: string
  isOpenAIModel?: boolean
  /**
   * Stable service identity used to keep caches isolated when the same
   * provider id is pointed at a different API service.
   */
  apiHost?: string
}

export interface PromptCacheAttachmentResult {
  providerOptions: PromptCacheProviderOptions
  scope: string
  field: 'promptCacheKey' | 'prompt_cache_key'
  promptCacheKey: string
}

const NATIVE_OPENAI_PROVIDER_IDS = new Set(['openai', 'openai-chat', 'azure', 'azure-responses'])

export function buildPromptCacheKey(
  topicId: string,
  providerId: string,
  modelId: string,
  serviceScope?: string
): string {
  const baseKey = `${topicId}:${providerId}:${modelId}`
  if (!serviceScope) {
    return baseKey
  }

  return `${baseKey}:svc-${stableHash(serviceScope)}`
}

function stableHash(value: string): string {
  // FNV-1a keeps the cache key short while remaining deterministic across
  // desktop sessions and runtimes.
  let hash = 2166136261
  for (const char of value) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function normalizeApiHost(apiHost?: string): string {
  if (!apiHost) return ''

  try {
    const url = new URL(apiHost)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '').toLowerCase()
  } catch {
    return apiHost.trim().replace(/\/$/, '').toLowerCase()
  }
}

function isNativeOpenAIRequest(context: PromptCacheAttachmentContext): boolean {
  if (NATIVE_OPENAI_PROVIDER_IDS.has(context.runtimeProviderId)) {
    return true
  }

  // These gateway providers choose the concrete SDK at runtime.
  if (context.actualProviderId === 'newapi' && context.modelEndpointType === 'openai-response') {
    return true
  }
  if (context.actualProviderId === 'aihubmix' && context.isOpenAIModel) {
    return true
  }

  return false
}

function resolveProviderOptionsScope(
  providerOptions: PromptCacheProviderOptions,
  context: PromptCacheAttachmentContext,
  nativeOpenAI: boolean
): string {
  if (nativeOpenAI) {
    // OpenAI and gateway-native OpenAI models parse the `openai` scope. Azure
    // has its own scope in the SDK.
    return context.runtimeProviderId === 'azure' || context.runtimeProviderId === 'azure-responses' ? 'azure' : 'openai'
  }

  const candidates = [context.actualProviderId, context.runtimeProviderId].filter(Boolean)
  return (
    candidates.find((candidate) => Object.prototype.hasOwnProperty.call(providerOptions, candidate)) || candidates[0]
  )
}

export function attachPromptCacheKeyToProviderOptions(
  providerOptions: PromptCacheProviderOptions,
  topicId: string | undefined,
  context: PromptCacheAttachmentContext
): PromptCacheAttachmentResult | undefined {
  if (!topicId) {
    return undefined
  }

  const nativeOpenAI = isNativeOpenAIRequest(context)
  const scope = resolveProviderOptionsScope(providerOptions, context, nativeOpenAI)
  const field = nativeOpenAI ? 'promptCacheKey' : 'prompt_cache_key'
  const serviceScope = [
    normalizeApiHost(context.apiHost),
    context.runtimeProviderId,
    context.actualProviderId,
    context.modelEndpointType || ''
  ].join('|')
  const promptCacheKey = buildPromptCacheKey(topicId, context.actualProviderId, context.modelId, serviceScope)

  return {
    providerOptions: {
      ...providerOptions,
      [scope]: {
        ...providerOptions[scope],
        [field]: promptCacheKey
      }
    },
    scope,
    field,
    promptCacheKey
  }
}
