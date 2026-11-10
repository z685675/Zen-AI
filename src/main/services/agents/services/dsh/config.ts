import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { config as apiConfigService } from '@main/apiServer/config'
import { cleanupAssistantMcpContext, registerAssistantMcpContext } from '@main/apiServer/routes/assistant-mcp'
import { cleanupBrowserMcpContext, registerBrowserMcpContext } from '@main/apiServer/routes/browser-mcp'
import { mcpApiService } from '@main/apiServer/services/mcp'
import { recordMainDiagnostic } from '@main/services/DiagnosticEvidenceService'
import { getDataPath } from '@main/utils'
import { getOpenCodeAgentMode } from '@shared/agents/opencodeMode'
import { isZenManagedApiHost } from '@shared/config/zenProvider'
import { formatApiHost } from '@shared/utils/api'
import type { GetAgentSessionResponse, Provider } from '@types'

import type { DshRuntimeConfig } from '../../../dshPreview/runtime'
import { SkillRepository } from '../../skills/SkillRepository'
import { confirmAssistantFileOverwrite } from '../opencode/fileApproval'
import { createOpenCodeGateway } from '../opencode/gateway'
import { getOpenCodeModeInstructions, OPENCODE_SYSTEM_INSTRUCTIONS } from '../opencode/instructions'
import { getAgentProtocolBridgeTarget, modelDeclaresAnthropicProtocol } from '../runtime/protocol'

export function dshProviderConfig(
  provider: Provider,
  modelId: string,
  sessionId: string
): DshRuntimeConfig['provider'] {
  const model = provider.models.find((entry) => entry.id === modelId)
  const endpoint = getAgentProtocolBridgeTarget(provider, model)
  if (['aws-bedrock', 'azure-openai', 'vertexai', 'vertex-anthropic'].includes(provider.type))
    throw new Error(
      `The pinned DeepSeek Harness preview does not support ${provider.type} authentication/protocol. Use an explicitly configured OpenAI-compatible or Anthropic endpoint.`
    )
  if (endpoint === 'gemini' || provider.type === 'gemini')
    throw new Error(
      'This DeepSeek Harness preview supports OpenAI-compatible and Anthropic APIs. The selected Gemini protocol is not supported by its pinned native adapter.'
    )
  const anthropic = modelDeclaresAnthropicProtocol(model) || (!endpoint && provider.type === 'anthropic')
  if (!endpoint && !anthropic)
    throw new Error(`Unsupported provider protocol for the DeepSeek Harness preview: ${provider.type}`)
  const context = Math.min(200000, Math.max(1024, model?.contextWindowTokens || 128000))
  return {
    api: anthropic ? 'anthropic-messages' : endpoint === 'openai-responses' ? 'openai-responses' : 'openai-completions',
    baseURL: formatApiHost(anthropic ? provider.anthropicApiHost || provider.apiHost : provider.apiHost),
    model: modelId,
    apiKey: provider.apiKey || undefined,
    headers: { ...provider.extra_headers, 'X-Zen-Session-Id': sessionId },
    contextWindow: context,
    maxTokens: Math.min(model?.maxOutputTokens || 16000, Math.floor(context / 8))
  }
}

export async function prepareDshConfig(
  session: GetAgentSessionResponse,
  provider: Provider,
  modelId: string,
  signal: AbortSignal,
  readNativeSkills: () => Promise<any> | undefined,
  effort?: string,
  diagnosticId?: string
) {
  const workspace = session.accessible_paths[0]
  if (!workspace) throw new Error('No accessible workspace for the DeepSeek Harness preview')
  if (session.allowed_tools?.length)
    throw new Error(
      'The DeepSeek Harness preview cannot apply legacy per-tool allowlists. Clear the tool allowlist or use the standard assistant.'
    )
  const selected = dshProviderConfig(provider, modelId, session.id)
  const lastProgress = new Map<string, number>()
  const gateway = await createOpenCodeGateway(
    selected.baseURL,
    (id, event, details) => {
      if (['body-progress', 'tool-input-progress'].includes(event)) {
        const previous = lastProgress.get(event) || 0
        if (Date.now() - previous < 10000) return
        lastProgress.set(event, Date.now())
      }
      recordMainDiagnostic(id, 'transport', event, { ...details, runtime: 'dsh' })
    },
    isZenManagedApiHost(selected.baseURL) ? modelId : undefined
  )
  gateway.setOperation(diagnosticId)
  try {
    const skillRoots = [path.join(workspace, '.agents', 'skills')]
    const skills = await SkillRepository.getInstance().list()
    // DSH scans roots containing skill bundles, while Zen stores enabled skills
    // individually. Mirror only their directory links in a private catalog.
    const catalog = path.join(
      getDataPath('DSHPreview'),
      'skill-catalogs',
      createHash('sha256').update(session.id).digest('hex')
    )
    await fs.mkdir(catalog, { recursive: true })
    const enabled = skills.filter((skill) => skill.isEnabled)
    const names = new Set(enabled.map((skill) => skill.folderName))
    for (const entry of await fs.readdir(catalog, { withFileTypes: true })) {
      if (!names.has(entry.name))
        await fs.rm(path.join(catalog, entry.name), { force: true, recursive: !entry.isSymbolicLink() })
    }
    for (const skill of enabled) {
      if (!/^[a-zA-Z0-9_-]+$/.test(skill.folderName)) continue
      const source = path.join(getDataPath('Skills'), skill.folderName)
      const target = path.join(catalog, skill.folderName)
      if (!(await fs.lstat(target).catch(() => undefined)))
        await fs.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    }
    skillRoots.push(catalog)
    const api = await apiConfigService.get()
    const host = ['0.0.0.0', '::'].includes(api.host) ? '127.0.0.1' : api.host
    const baseURL = `http://${host.includes(':') ? `[${host}]` : host}:${api.port}`
    const readOnly = getOpenCodeAgentMode(session.configuration?.permission_mode) === 'plan'
    registerAssistantMcpContext(session.id, session.accessible_paths, {
      workspace,
      signal,
      readOnly,
      readNativeSkills: async () => (await readNativeSkills()) || [],
      approveOverwrite: (file) => (readOnly ? Promise.resolve(false) : confirmAssistantFileOverwrite(file, signal)),
      onTool: (name, durationMs, failed) =>
        recordMainDiagnostic(diagnosticId, 'runtime', 'product-tool-complete', {
          runtime: 'dsh',
          tool: name,
          durationMs,
          failed
        })
    })
    registerBrowserMcpContext(session.id)
    const mcp = (serverName: string, route: string) => ({
      transport: 'streamable-http',
      serverName,
      url: `${baseURL}/v1/${route}/${encodeURIComponent(session.id)}/mcp`,
      headers: { Authorization: `Bearer ${api.apiKey}` },
      toolCallTimeoutMs: route === 'browser' ? 15 * 60000 : 120000,
      failOnStartupError: true
    })
    const externalMcp: Record<string, unknown>[] = []
    const approveToolPrefixes: string[] = []
    for (const id of session.mcps || []) {
      signal.throwIfAborted()
      if (!(await mcpApiService.getServerInfo(id))) throw new Error(`Selected MCP server is unavailable: ${id}`)
      const serverName = `external_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`
      externalMcp.push({
        transport: 'streamable-http',
        serverName,
        url: `${baseURL}/v1/mcps/${encodeURIComponent(id)}/mcp`,
        headers: { Authorization: `Bearer ${api.apiKey}` },
        toolCallTimeoutMs: 120000,
        failOnStartupError: true
      })
      approveToolPrefixes.push(`mcp__${serverName}__`)
    }
    const config: DshRuntimeConfig = {
      sessionId: session.id,
      cwd: workspace,
      provider: {
        ...selected,
        baseURL: gateway.baseURL,
        headers: { ...selected.headers, 'x-zen-runtime-token': gateway.token }
      },
      additionalRoots: session.accessible_paths.slice(1),
      skillRoots,
      mcp: [mcp('assistant', 'assistant'), mcp('browser', 'browser'), ...externalMcp],
      approveToolPrefixes,
      readOnly,
      instructions: [
        OPENCODE_SYSTEM_INSTRUCTIONS.replaceAll('OpenCode', 'DeepSeek Harness').replace(
          'Load independent Skills together; skill requires name.',
          'Use the native skill tool and its actual parameter schema to load relevant Skills.'
        ),
        session.instructions,
        getOpenCodeModeInstructions(session.configuration?.permission_mode)
      ]
        .filter(Boolean)
        .join('\n\n'),
      ...(effort && ['minimal', 'low', 'medium', 'high', 'max', 'xhigh'].includes(effort) ? { effort } : {})
    }
    return {
      config,
      finishTurn: () => gateway.finishTurn(),
      dispose: () => {
        cleanupAssistantMcpContext(session.id)
        cleanupBrowserMcpContext(session.id)
        gateway.stop()
      }
    }
  } catch (error) {
    cleanupAssistantMcpContext(session.id)
    cleanupBrowserMcpContext(session.id)
    gateway.stop()
    throw error
  }
}
