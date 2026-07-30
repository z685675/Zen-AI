import { validateModelId } from '@main/apiServer/utils'
import type { AgentRuntime, AgentType } from '@types'

import type { AgentServiceInterface } from '../../interfaces/AgentStreamInterface'
import ClaudeCodeService from '../claudecode'
import CodexService from '../codex'
import { type AgentRuntimeCapabilities, getAgentRuntimeCapabilities } from './compatibility'
import { isCodexRuntimeEnabled } from './features'

const claudeCodeService = new ClaudeCodeService()
const codexService = new CodexService()

export type AgentRuntimeId = AgentType | 'codex'

type RuntimeResolvableSession = {
  id?: string
  agent_type: AgentType
  model?: string
  configuration?: {
    agent_runtime?: unknown
  }
}

type RuntimeModelValidation = Awaited<ReturnType<typeof validateModelId>>

export type AgentRuntimeResolution = {
  runtimeId: AgentRuntimeId
  candidates: AgentRuntimeId[]
  configuredRuntime: unknown
  source: 'environment-override' | 'configuration-override' | 'auto' | 'legacy-fallback'
  reason: string
  capabilities?: AgentRuntimeCapabilities
  modelId?: string
}

type ResolveRuntimeOptions = {
  env?: NodeJS.ProcessEnv
  validateModel?: (model: string) => Promise<RuntimeModelValidation>
  codexEnabled?: boolean
}

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on'])

function isRuntimeOverride(value: unknown): value is Exclude<AgentRuntime, 'auto'> {
  return value === 'claude-code' || value === 'codex'
}

function getEnvironmentRuntimeOverride(env: NodeJS.ProcessEnv): AgentRuntimeId | undefined {
  const value = env.ZEN_AGENT_RUNTIME_OVERRIDE?.trim().toLowerCase()
  return isRuntimeOverride(value) ? value : undefined
}

function isConfigurationOverrideEnabled(env: NodeJS.ProcessEnv): boolean {
  return ENABLED_VALUES.has(env.ZEN_ENABLE_AGENT_RUNTIME_CONFIG_OVERRIDE?.trim().toLowerCase() ?? '')
}

function getModelAffinity(modelId: string): AgentRuntimeId | undefined {
  const normalized = modelId.toLowerCase()

  if (normalized.includes('claude')) {
    return 'claude-code'
  }

  if (normalized.includes('gemini') || normalized.includes('grok')) {
    return 'claude-code'
  }

  if (normalized.includes('gpt') || normalized.includes('codex') || /^o\d(?:[-_.]|$)/.test(normalized)) {
    return 'codex'
  }

  return undefined
}

function capabilityScore(state: AgentRuntimeCapabilities[AgentRuntimeId]['state']): number {
  switch (state) {
    case 'verified':
      return 40
    case 'declared':
      return 25
    case 'unknown':
      return 0
    case 'unsupported':
      return Number.NEGATIVE_INFINITY
  }
}

export function buildAutoRuntimeResolution(params: {
  session: RuntimeResolvableSession
  provider?: RuntimeModelValidation['provider']
  modelId?: string
  codexEnabled: boolean
}): AgentRuntimeResolution {
  const selectedModel = params.provider?.models?.find((model) => model.id === params.modelId)
  const capabilities = getAgentRuntimeCapabilities(params.provider, selectedModel)
  const affinity = params.modelId ? getModelAffinity(params.modelId) : undefined
  const runtimes: AgentRuntimeId[] = params.codexEnabled ? ['claude-code', 'codex'] : ['claude-code']

  const candidates = runtimes
    .map((runtimeId, index) => {
      const stateScore = capabilityScore(capabilities[runtimeId].state)
      const affinityScore = affinity === runtimeId ? 100 : 0
      const continuityScore = params.session.agent_type === runtimeId ? 10 : 0
      return { runtimeId, score: stateScore + affinityScore + continuityScore, index }
    })
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((candidate) => candidate.runtimeId)

  const fallbackRuntime = params.session.agent_type
  const orderedCandidates = candidates.length > 0 ? candidates : [fallbackRuntime]
  const runtimeId = orderedCandidates[0]
  const capability = capabilities[runtimeId]

  return {
    runtimeId,
    candidates: orderedCandidates,
    configuredRuntime: params.session.configuration?.agent_runtime ?? 'auto',
    source: 'auto',
    reason: [
      `model-affinity:${affinity ?? 'none'}`,
      `selected-capability:${capability.state}`,
      ...capability.evidence
    ].join(','),
    capabilities,
    modelId: params.modelId
  }
}

export async function resolveAgentRuntime(
  session: RuntimeResolvableSession,
  options: ResolveRuntimeOptions = {}
): Promise<AgentRuntimeResolution> {
  const env = options.env ?? process.env
  const configuredRuntime = session.configuration?.agent_runtime ?? 'auto'
  const environmentOverride = getEnvironmentRuntimeOverride(env)

  if (environmentOverride) {
    return {
      runtimeId: environmentOverride,
      candidates: [environmentOverride],
      configuredRuntime,
      source: 'environment-override',
      reason: 'ZEN_AGENT_RUNTIME_OVERRIDE'
    }
  }

  if (isConfigurationOverrideEnabled(env) && isRuntimeOverride(configuredRuntime)) {
    return {
      runtimeId: configuredRuntime,
      candidates: [configuredRuntime],
      configuredRuntime,
      source: 'configuration-override',
      reason: 'ZEN_ENABLE_AGENT_RUNTIME_CONFIG_OVERRIDE'
    }
  }

  if (!session.model) {
    return {
      runtimeId: session.agent_type,
      candidates: [session.agent_type],
      configuredRuntime,
      source: 'legacy-fallback',
      reason: 'session-model-missing'
    }
  }

  const validate = options.validateModel ?? validateModelId
  const modelInfo = await validate(session.model)
  if (!modelInfo.valid || !modelInfo.provider || !modelInfo.modelId) {
    return {
      runtimeId: session.agent_type,
      candidates: [session.agent_type],
      configuredRuntime,
      source: 'legacy-fallback',
      reason: 'model-validation-failed'
    }
  }

  return buildAutoRuntimeResolution({
    session,
    provider: modelInfo.provider,
    modelId: modelInfo.modelId,
    codexEnabled: options.codexEnabled ?? isCodexRuntimeEnabled(env)
  })
}

export async function resolveAgentRuntimeId(session: RuntimeResolvableSession): Promise<AgentRuntimeId> {
  return (await resolveAgentRuntime(session)).runtimeId
}

export function getAgentRuntimeServiceById(runtimeId: AgentRuntimeId): AgentServiceInterface {
  switch (runtimeId) {
    case 'claude-code':
      return claudeCodeService
    case 'codex':
      return codexService
    default:
      throw new Error(`Unsupported agent runtime: ${runtimeId}`)
  }
}

export async function getAgentRuntimeService(session: RuntimeResolvableSession): Promise<AgentServiceInterface> {
  return getAgentRuntimeServiceById(await resolveAgentRuntimeId(session))
}
