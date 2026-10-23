import path from 'node:path'

import type { GetAgentSessionResponse, Provider } from '@types'

import {
  OPENCODE_HEADERS_TIMEOUT_MS,
  OPENCODE_REQUEST_TIMEOUT_MS,
  OPENCODE_STREAM_CHUNK_TIMEOUT_MS
} from '../../../../../../packages/shared/agents/opencodeLimits'
import { formatApiHost } from '../../../../../../packages/shared/utils/api'
import { withoutTrailingApiVersion } from '../../../../../../packages/shared/utils/api/utils'
import { getAutomationProfile, LIGHTWEIGHT_TOOLS } from '../automation/profile'
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
  const lightweight = Boolean(getAutomationProfile(session))
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
    skills: { paths: lightweight ? [] : input.skillPaths, urls: [] },
    // Use the native image normalizer, not a second lossy preprocessing chain.
    attachment: {
      image: { auto_resize: true, max_width: 2000, max_height: 2000, max_base64_bytes: 5 * 1024 * 1024 }
    },
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
          timeout: OPENCODE_REQUEST_TIMEOUT_MS,
          headerTimeout: OPENCODE_HEADERS_TIMEOUT_MS,
          chunkTimeout: OPENCODE_STREAM_CHUNK_TIMEOUT_MS
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
    mcp: Object.fromEntries(
      lightweight
        ? [mcp('mcp__assistant_', 'assistant')]
        : [mcp('mcp__assistant_', 'assistant'), mcp('mcp__browser_', 'browser')]
    ),
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
      mcp__assistant__read_document: 'allow',
      // Native permission patterns, not a second command parser or a sandbox.
      // Ordinary automatic tasks remain automatic; common deletion commands still ask.
      bash: readOnly
        ? 'deny'
        : {
            '*': permission,
            ...Object.fromEntries(
              ['rm', 'rmdir', 'del', 'erase', 'rd', 'Remove-Item', 'remove-item', 'REMOVE-ITEM', 'DEL', 'RD'].flatMap(
                (command) => [
                  [command, 'ask'],
                  [`${command} *`, 'ask'],
                  [`* ${command} *`, 'ask'],
                  [`*/${command} *`, 'ask'],
                  [`*\\${command} *`, 'ask']
                ]
              )
            )
          },
      ...(readOnly ? { edit: 'deny' } : {}),
      question: 'deny',
      ...(lightweight
        ? {
            '*': 'deny',
            read: 'deny',
            glob: 'deny',
            grep: 'deny',
            skill: 'deny',
            external_directory: 'deny',
            bash: 'deny',
            edit: 'deny',
            'mcp__assistant_*': 'deny',
            'mcp__browser_*': 'deny',
            ...Object.fromEntries(LIGHTWEIGHT_TOOLS.map((tool) => [`mcp__assistant__${tool}`, 'allow']))
          }
        : {})
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
