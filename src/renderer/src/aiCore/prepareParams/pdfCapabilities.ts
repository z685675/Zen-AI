import { isAnthropicModel, isGeminiModel } from '@renderer/config/models'
import { isOpenAILLMModel } from '@renderer/config/models/openai'
import type { Model, Provider, ProviderType } from '@renderer/types'

const PDF_NATIVE_PROVIDER_TYPES = new Set<ProviderType>([
  'openai-response',
  'anthropic',
  'gemini',
  'azure-openai',
  'vertexai',
  'aws-bedrock',
  'vertex-anthropic'
])

export function supportsNativePdfInput(provider: Provider, model: Model, runtimeProviderId?: string): boolean {
  if (runtimeProviderId === 'openai' || runtimeProviderId === 'google' || runtimeProviderId === 'anthropic') {
    return true
  }
  if (runtimeProviderId === 'google-vertex' && isGeminiModel(model)) {
    return true
  }
  if (runtimeProviderId === 'google-vertex-anthropic' && isAnthropicModel(model)) {
    return true
  }
  if (PDF_NATIVE_PROVIDER_TYPES.has(provider.type)) {
    return true
  }
  if (
    model.endpoint_type === 'openai-response' ||
    model.endpoint_type === 'anthropic' ||
    model.endpoint_type === 'gemini'
  ) {
    return true
  }
  if ((provider.type === 'openai-response' || provider.type === 'azure-openai') && isOpenAILLMModel(model)) {
    return true
  }
  if (provider.type === 'vertex-anthropic' && isAnthropicModel(model)) {
    return true
  }
  if (provider.type === 'vertexai' && isGeminiModel(model)) {
    return true
  }
  return false
}
