export type AgentProtocolBridgeTarget = 'gemini' | 'openai-chat' | 'openai-responses' | 'xai-chat'

type ProtocolProvider = {
  id?: string
  type?: string
  anthropicApiHost?: string
}

type ProtocolModel = {
  id?: string
  endpoint_type?: string
  supported_endpoint_types?: string[]
}

const OPENAI_CHAT_PROVIDER_TYPES = new Set(['openai', 'ollama', 'mistral'])
const OPENAI_GATEWAY_PROVIDER_TYPES = new Set(['new-api', 'gateway'])

function declaredEndpoints(model: ProtocolModel | undefined): Set<string> {
  return new Set([model?.endpoint_type, ...(model?.supported_endpoint_types ?? [])].filter(Boolean) as string[])
}

export function modelDeclaresAnthropicProtocol(model: ProtocolModel | undefined): boolean {
  if (model?.endpoint_type) {
    return model.endpoint_type === 'anthropic'
  }

  const endpoints = declaredEndpoints(model)
  return endpoints.size === 1 && endpoints.has('anthropic')
}

export function getAgentProtocolBridgeTarget(
  provider: ProtocolProvider | undefined,
  model: ProtocolModel | undefined
): AgentProtocolBridgeTarget | undefined {
  if (!provider || modelDeclaresAnthropicProtocol(model)) {
    return undefined
  }

  const endpoints = declaredEndpoints(model)

  if (model?.endpoint_type === 'gemini') {
    return 'gemini'
  }

  if (model?.endpoint_type === 'openai-response' || provider.type === 'openai-response') {
    return 'openai-responses'
  }

  if (provider.type === 'gemini') {
    return 'gemini'
  }

  if (provider.type === 'xai' || provider.type === 'grok') {
    return 'xai-chat'
  }

  if (model?.endpoint_type === 'openai') {
    return 'openai-chat'
  }

  if (
    provider.type &&
    (OPENAI_CHAT_PROVIDER_TYPES.has(provider.type) || OPENAI_GATEWAY_PROVIDER_TYPES.has(provider.type))
  ) {
    return 'openai-chat'
  }

  if (endpoints.has('openai')) {
    return 'openai-chat'
  }

  if (endpoints.size === 1 && endpoints.has('gemini')) {
    return 'gemini'
  }

  if (endpoints.size === 1 && endpoints.has('openai-response')) {
    return 'openai-responses'
  }

  return undefined
}

export function shouldUseAgentProtocolBridge(
  provider: ProtocolProvider | undefined,
  model: ProtocolModel | undefined
): boolean {
  if (!provider || provider.anthropicApiHost?.trim()) return false
  return getAgentProtocolBridgeTarget(provider, model) !== undefined
}
