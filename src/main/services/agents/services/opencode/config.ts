import path from 'node:path'

import type { GetAgentSessionResponse, Provider } from '@types'

import { formatApiHost } from '../../../../../../packages/shared/utils/api'
import { withoutTrailingApiVersion } from '../../../../../../packages/shared/utils/api/utils'
import { getAgentProtocolBridgeTarget, modelDeclaresAnthropicProtocol } from '../runtime/protocol'

export const OPENCODE_VERSION = '1.18.35'
export const OPENCODE_PROVIDER_ID = 'zen-selected'

export function buildOpenCodeConfig(input: {
  session: GetAgentSessionResponse
  provider: Provider
  modelId: string
  skillPaths: string[]
  api: { host: string; port: number; apiKey: string }
  effort?: string
}) {
  const { session, provider, modelId } = input
  const host = ['0.0.0.0', '::'].includes(input.api.host) ? '127.0.0.1' : input.api.host
  const apiBase = `http://${host.includes(':') ? `[${host}]` : host}:${input.api.port}`
  const model = provider.models.find((candidate) => candidate.id === modelId)
  const endpoint = getAgentProtocolBridgeTarget(provider, model)
  const npm =
    modelDeclaresAnthropicProtocol(model) || (!endpoint && provider.type === 'anthropic')
      ? '@ai-sdk/anthropic'
      : endpoint === 'gemini'
        ? '@ai-sdk/google'
        : endpoint === 'openai-responses'
          ? '@ai-sdk/openai'
          : '@ai-sdk/openai-compatible'
  // Unknown aliases must still have a finite compaction budget. This is a
  // product ceiling, not a claim that every upstream accepts 200K tokens.
  const configuredContext = model?.contextWindowTokens
  const context = Math.min(
    200_000,
    Math.max(1024, Number.isFinite(configuredContext) && configuredContext! > 0 ? configuredContext! : 128_000)
  )
  const configuredOutput = model?.maxOutputTokens
  const output = Math.min(
    Number.isFinite(configuredOutput) && configuredOutput! > 0 ? configuredOutput! : 16_000,
    Math.floor(context / 8)
  )
  const allowedRoots = [...session.accessible_paths, ...input.skillPaths]
  const externalDirectories = Object.fromEntries(
    allowedRoots.map((root) => [path.resolve(root).replaceAll('\\', '/') + '/**', 'allow'])
  )
  const permission = session.configuration?.permission_mode === 'bypassPermissions' ? 'allow' : 'ask'
  const readOnly = session.configuration?.permission_mode === 'plan'
  const mcp = (name: string, route: string) =>
    [
      name,
      {
        type: 'remote',
        url: `${apiBase}/v1/${route}/${encodeURIComponent(session.id)}/mcp`,
        headers: { Authorization: `Bearer ${input.api.apiKey}` },
        oauth: false,
        enabled: true,
        // Login/CAPTCHA handoff can legitimately take longer than a normal
        // file tool. The overall task deadline still bounds this wait.
        timeout: route === 'browser' ? 15 * 60_000 : 120_000
      }
    ] as const
  return {
    $schema: 'https://opencode.ai/config.json',
    model: `${OPENCODE_PROVIDER_ID}/${modelId}`,
    small_model: `${OPENCODE_PROVIDER_ID}/${modelId}`,
    enabled_providers: [OPENCODE_PROVIDER_ID],
    autoupdate: false,
    share: 'disabled',
    plugin: [],
    snapshot: false,
    lsp: false,
    formatter: false,
    agent: { title: { disable: true } },
    instructions: [],
    skills: { paths: input.skillPaths, urls: [] },
    compaction: {
      auto: true,
      prune: true,
      reserved: Math.min(output + 8_000, Math.floor(context / 3)),
      preserve_recent_tokens: Math.min(8_000, Math.floor(context / 4))
    },
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm,
        name: 'Zen AI selected Provider',
        env: [],
        options: {
          baseURL:
            endpoint === 'gemini'
              ? formatApiHost(withoutTrailingApiVersion(provider.apiHost), true, 'v1beta')
              : npm === '@ai-sdk/anthropic'
                ? formatApiHost(provider.anthropicApiHost || provider.apiHost)
                : formatApiHost(provider.apiHost),
          apiKey: provider.apiKey || undefined,
          headers: {
            ...provider.extra_headers,
            'User-Agent': `ZenAI-OpenCode/${OPENCODE_VERSION}`,
            Originator: 'zenai_opencode',
            'X-Zen-Session-Id': session.id
          },
          timeout: 180_000,
          headerTimeout: 60_000,
          chunkTimeout: 60_000
        },
        models: {
          [modelId]: {
            id: modelId,
            name: model?.name || modelId,
            attachment: true,
            tool_call: true,
            reasoning: true,
            limit: { context, output },
            modalities: { input: ['text', 'image'], output: ['text'] },
            ...(/gpt|^o\d|codex/i.test(modelId) && input.effort ? { options: { reasoningEffort: input.effort } } : {})
          }
        }
      }
    },
    // MCP naming deliberately matches existing Skill instructions.
    mcp: Object.fromEntries([mcp('mcp__assistant_', 'assistant'), mcp('mcp__browser_', 'browser')]),
    permission: {
      '*': permission,
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      skill: { '*': 'allow', 'customize-opencode': 'deny' },
      external_directory: { '*': 'ask', ...externalDirectories },
      websearch: 'deny',
      'mcp__assistant_*': readOnly ? 'deny' : 'allow',
      'mcp__browser_*': readOnly ? 'deny' : 'allow',
      mcp__assistant__web_search: 'allow',
      mcp__assistant__environment: 'allow',
      mcp__assistant__skill_status: 'allow',
      ...(readOnly ? { edit: 'deny', bash: 'deny' } : {}),
      question: 'deny'
    }
  }
}

export function buildOpenCodeEnvironment(
  base: NodeJS.ProcessEnv,
  root: string,
  password: string,
  toolBinDir?: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    if (
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|PROGRAMDATA|LANG|LC_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(
        name
      )
    )
      env[name] = value
  }
  // Include this stable directory even before background installation finishes.
  // Normalize PATH casing so Windows spawn cannot choose a stale duplicate.
  if (toolBinDir) {
    const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')
    const directories = [toolBinDir, ...pathKeys.flatMap((key) => (env[key] ?? '').split(path.delimiter))]
    for (const key of pathKeys) delete env[key]
    env.PATH = [...new Set(directories.filter(Boolean))].join(path.delimiter)
  }
  return {
    ...env,
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_CONFIG_DIR: path.join(root, 'config', 'opencode'),
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_PURE: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true',
    OPENCODE_EXPERIMENTAL: 'false',
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    NO_PROXY: [base.NO_PROXY, base.no_proxy, '127.0.0.1,localhost,::1'].filter(Boolean).join(','),
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
    OPENCODE_SERVER_USERNAME: 'zen-ai',
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CLIENT: 'zen-ai'
  }
}
