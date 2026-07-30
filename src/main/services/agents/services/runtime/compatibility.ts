import { getAgentProtocolBridgeTarget } from './protocol'

export type AgentRuntimeCompatibility = 'claude-code' | 'codex'
export type AgentRuntimeCapabilityState = 'verified' | 'declared' | 'unknown' | 'unsupported'

export type AgentRuntimeCapability = {
  state: AgentRuntimeCapabilityState
  evidence: string[]
}

export type AgentRuntimeCapabilities = Record<AgentRuntimeCompatibility, AgentRuntimeCapability>

type RuntimeProvider = {
  id?: string
  type?: string
  anthropicApiHost?: string
}

type RuntimeModel = {
  id?: string
  endpoint_type?: string
  supported_endpoint_types?: string[]
}

const OPENAI_ENDPOINT_TYPES = new Set(['openai', 'openai-response'])
const DIRECT_OPENAI_PROVIDER_TYPES = new Set(['openai', 'openai-response', 'azure-openai'])

function declaredCapability(...evidence: Array<string | false | undefined>): AgentRuntimeCapability {
  return {
    state: 'declared',
    evidence: evidence.filter((item): item is string => Boolean(item))
  }
}

function unknownCapability(reason: string): AgentRuntimeCapability {
  return { state: 'unknown', evidence: [reason] }
}

function unsupportedCapability(reason: string): AgentRuntimeCapability {
  return { state: 'unsupported', evidence: [reason] }
}

export function getAgentRuntimeCapabilities(
  provider: RuntimeProvider | undefined,
  model: RuntimeModel | undefined
): AgentRuntimeCapabilities {
  if (!provider) {
    return {
      'claude-code': unknownCapability('provider-not-resolved'),
      codex: unknownCapability('provider-not-resolved')
    }
  }

  const endpointType = model?.endpoint_type
  const supportedEndpointTypes = (model?.supported_endpoint_types ?? []).filter(Boolean)
  const hasExclusiveEndpointDeclaration = supportedEndpointTypes.length > 0
  const declaresAnthropicEndpoint = endpointType === 'anthropic' || supportedEndpointTypes.includes('anthropic')
  const declaresOpenAIEndpoint =
    Boolean(endpointType && OPENAI_ENDPOINT_TYPES.has(endpointType)) ||
    supportedEndpointTypes.some((candidate) => OPENAI_ENDPOINT_TYPES.has(candidate))
  const hasAnthropicHost = Boolean(provider.anthropicApiHost?.trim())
  const bridgeTarget = getAgentProtocolBridgeTarget(provider, model)

  let claudeCode: AgentRuntimeCapability
  if (
    declaresAnthropicEndpoint ||
    provider.type === 'anthropic' ||
    provider.type === 'azure-openai' ||
    hasAnthropicHost
  ) {
    claudeCode = declaredCapability(
      declaresAnthropicEndpoint && 'model-declares-anthropic-endpoint',
      provider.type === 'anthropic' && 'provider-type-anthropic',
      provider.type === 'azure-openai' && 'provider-type-azure-openai',
      hasAnthropicHost && 'provider-has-anthropic-api-host'
    )
  } else if (bridgeTarget) {
    claudeCode = declaredCapability(`zen-protocol-bridge-${bridgeTarget}`)
  } else if (hasExclusiveEndpointDeclaration) {
    claudeCode = unsupportedCapability('supported-endpoint-types-exclude-anthropic')
  } else {
    claudeCode = unknownCapability('anthropic-protocol-not-declared')
  }

  let codex: AgentRuntimeCapability
  if (declaresOpenAIEndpoint) {
    codex = declaredCapability('model-declares-openai-endpoint')
  } else if (hasExclusiveEndpointDeclaration) {
    codex = unsupportedCapability('supported-endpoint-types-exclude-openai')
  } else if (provider.type && DIRECT_OPENAI_PROVIDER_TYPES.has(provider.type)) {
    codex = declaredCapability(`provider-type-${provider.type}`)
  } else {
    codex = unknownCapability('openai-protocol-not-declared')
  }

  return { 'claude-code': claudeCode, codex }
}

export function getAgentRuntimeCompatibility(
  provider: RuntimeProvider | undefined,
  model: RuntimeModel | undefined
): AgentRuntimeCompatibility[] {
  const capabilities = getAgentRuntimeCapabilities(provider, model)
  return (['claude-code', 'codex'] as const).filter((runtime) => capabilities[runtime].state !== 'unsupported')
}

export function isModelCompatibleWithAgentRuntime(
  provider: RuntimeProvider | undefined,
  model: RuntimeModel | undefined,
  runtime: AgentRuntimeCompatibility
): boolean {
  return getAgentRuntimeCapabilities(provider, model)[runtime].state !== 'unsupported'
}
