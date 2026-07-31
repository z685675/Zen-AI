import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { GetAgentSessionResponse } from '@types'

import type { AgentThinkingOptions } from '../../interfaces/AgentStreamInterface'
import { isModelCompatibleWithAgentRuntime } from '../runtime/compatibility'
import { mapCodexApprovalPolicy, mapCodexReasoningEffort } from './transform'

type CodexProviderModelConfig = {
  id: string
  endpoint_type?: string
  supported_endpoint_types?: string[]
}

export type CodexProviderConfig = {
  type?: string
  id?: string
  apiKey?: string
  apiHost?: string
  apiVersion?: string
  models?: CodexProviderModelConfig[]
}

export type CodexMcpServerConfig = {
  url: string
  bearer_token_env_var?: string
}

export type CodexInput =
  | string
  | Array<
      | {
          type: 'text'
          text: string
        }
      | {
          type: 'local_image'
          path: string
        }
    >

export type CodexPreparedInput = {
  input: CodexInput
  cleanup: () => Promise<void>
}

export type CodexClientOptions = {
  codexPathOverride?: string
  apiKey?: string
  baseUrl?: string
  env: Record<string, string>
  config: {
    model_provider: string
    model_providers: Record<
      string,
      {
        name: string
        base_url: string
        env_key: string
        wire_api: 'responses'
        requires_openai_auth: boolean
        supports_websockets: boolean
      }
    >
    show_raw_agent_reasoning: boolean
    sandbox_workspace_write: {
      network_access: boolean
    }
    mcp_servers?: Record<string, CodexMcpServerConfig>
  }
}

export type CodexThreadOptions = {
  model: string
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  workingDirectory: string
  skipGitRepoCheck: boolean
  modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  networkAccessEnabled: boolean
  webSearchMode: 'disabled' | 'cached' | 'live'
  approvalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted'
  additionalDirectories?: string[]
}

export type CodexInvocationConfig = {
  clientOptions: CodexClientOptions
  threadOptions: CodexThreadOptions
}

const ZEN_CODEX_PROVIDER_ID = 'zen-ai-selected-provider'
const CODEX_ROUTING_ENV_KEYS = new Set(['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_API_BASE', 'OPENAI_BASE_URL'])
const CODEX_BLOCKED_ENV_KEYS = new Set([
  ...CODEX_ROUTING_ENV_KEYS,
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ZEN_AGENT_MCP_API_KEY',
  'NODE_OPTIONS',
  '__PROTO__',
  'CONSTRUCTOR',
  'PROTOTYPE'
])

export function assertCodexProviderSupported(provider: CodexProviderConfig, modelId: string): void {
  const model = provider.models?.find((candidate) => candidate.id === modelId)

  if (!isModelCompatibleWithAgentRuntime(provider, model, 'codex')) {
    throw new Error(
      `The selected model explicitly excludes the OpenAI or OpenAI Responses protocol required by the current Auto route. Provider '${provider.id ?? 'unknown'}', model '${modelId}'.`
    )
  }
}

export function buildCodexMcpServers(
  mcpIds: string[] | undefined,
  apiConfig: { host: string; port: number }
): Record<string, CodexMcpServerConfig> | undefined {
  if (!mcpIds?.length) return undefined

  const servers: Record<string, CodexMcpServerConfig> = {}

  for (const [index, mcpId] of mcpIds.entries()) {
    const normalizedId = mcpId.replace(/[^a-zA-Z0-9_-]/g, '_') || `server_${index + 1}`
    const serverName = servers[normalizedId] ? `${normalizedId}_${index + 1}` : normalizedId
    servers[serverName] = {
      url: `http://${apiConfig.host}:${apiConfig.port}/v1/mcps/${encodeURIComponent(mcpId)}/mcp`,
      bearer_token_env_var: 'ZEN_AGENT_MCP_API_KEY'
    }
  }

  return servers
}

export function buildCodexEnv(
  baseEnv: Record<string, string | undefined>,
  userEnvVars?: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(baseEnv)) {
    if (CODEX_ROUTING_ENV_KEYS.has(key.toUpperCase())) {
      continue
    }
    if (typeof value === 'string') {
      env[key] = value
    }
  }

  env.ELECTRON_RUN_AS_NODE = '1'
  env.ELECTRON_NO_ATTACH_CONSOLE = '1'

  if (userEnvVars && typeof userEnvVars === 'object') {
    for (const [key, value] of Object.entries(userEnvVars)) {
      if (CODEX_BLOCKED_ENV_KEYS.has(key.toUpperCase())) {
        continue
      }
      if (typeof value === 'string') {
        env[key] = value
      }
    }
  }

  return env
}

export function buildCodexInvocationConfig(params: {
  session: GetAgentSessionResponse
  provider: CodexProviderConfig
  modelId: string
  cwd: string
  baseEnv: Record<string, string | undefined>
  codexExecutablePath?: string
  codexPathDirs?: string[]
  thinkingOptions?: AgentThinkingOptions
  mcpServers?: Record<string, CodexMcpServerConfig>
}): CodexInvocationConfig {
  assertCodexProviderSupported(params.provider, params.modelId)

  const env = buildCodexEnv(params.baseEnv, params.session.configuration?.env_vars)
  prependPathDirs(env, params.codexPathDirs)
  const apiKey = params.provider.apiKey?.trim() || params.provider.id || 'zen-ai'
  const baseUrl = params.provider.apiHost?.trim()
  if (!baseUrl) {
    throw new Error(
      `The selected Provider '${params.provider.id ?? 'unknown'}' has no API URL. Codex runtime will not fall back to a global or third-party route.`
    )
  }
  const additionalDirectories = params.session.accessible_paths.slice(1).filter(Boolean)
  const reasoningEffort = mapCodexReasoningEffort(params.thinkingOptions?.effort)

  return {
    clientOptions: {
      ...(params.codexExecutablePath ? { codexPathOverride: params.codexExecutablePath } : {}),
      apiKey,
      baseUrl,
      env,
      config: {
        // Codex also reads ~/.codex/config.toml. Pinning an invocation-scoped
        // provider prevents global profiles from rerouting a Zen AI session.
        model_provider: ZEN_CODEX_PROVIDER_ID,
        model_providers: {
          [ZEN_CODEX_PROVIDER_ID]: {
            name: 'Zen AI selected Provider',
            base_url: baseUrl,
            env_key: 'CODEX_API_KEY',
            wire_api: 'responses',
            requires_openai_auth: false,
            supports_websockets: false
          }
        },
        show_raw_agent_reasoning: true,
        sandbox_workspace_write: {
          network_access: true
        },
        ...(params.mcpServers ? { mcp_servers: params.mcpServers } : {})
      }
    },
    threadOptions: {
      model: params.modelId,
      sandboxMode:
        params.session.configuration?.permission_mode === 'bypassPermissions'
          ? 'danger-full-access'
          : 'workspace-write',
      workingDirectory: params.cwd,
      skipGitRepoCheck: true,
      ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
      networkAccessEnabled: true,
      webSearchMode: 'live',
      approvalPolicy: mapCodexApprovalPolicy(params.session.configuration?.permission_mode),
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {})
    }
  }
}

function prependPathDirs(env: Record<string, string>, pathDirs?: string[]): void {
  const dirs = pathDirs?.filter(Boolean)
  if (!dirs?.length) {
    return
  }

  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const currentPath = env[pathKey]
  env[pathKey] = [dirs.join(path.delimiter), currentPath].filter(Boolean).join(path.delimiter)
}

export async function prepareCodexInput(
  prompt: string,
  images?: Array<{ data: string; media_type: string }>
): Promise<CodexPreparedInput> {
  if (!images || images.length === 0) {
    return {
      input: prompt,
      cleanup: async () => {}
    }
  }

  const tempDir = await fs.mkdtemp(path.join(getTempDir(), 'zen-codex-images-'))
  const input: Extract<CodexInput, unknown[]> = [{ type: 'text', text: prompt }]
  const cleanup = async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }

  try {
    for (const [index, image] of images.entries()) {
      const ext = mediaTypeToExtension(image.media_type)
      const imagePath = path.join(tempDir, `image-${index + 1}${ext}`)
      await fs.writeFile(imagePath, Buffer.from(image.data, 'base64'))
      input.push({ type: 'local_image', path: imagePath })
    }
  } catch (error) {
    await cleanup()
    throw error
  }

  return { input, cleanup }
}

function mediaTypeToExtension(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    case 'image/png':
    default:
      return '.png'
  }
}

function getTempDir(): string {
  return process.env.TEMP || process.env.TMP || process.env.TMPDIR || process.cwd()
}
