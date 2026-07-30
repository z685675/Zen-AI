import { isDev } from '@main/constant'

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on'])
const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off'])

export function isCodexRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configuredValue = env.ZEN_ENABLE_CODEX_RUNTIME?.trim().toLowerCase()

  if (configuredValue && ENABLED_VALUES.has(configuredValue)) return true
  if (configuredValue && DISABLED_VALUES.has(configuredValue)) return false

  return isDev
}

export function getCodexRuntimeDisabledError(): Error {
  return new Error(
    'The Codex runtime candidate is disabled in this build. Auto will use another available runtime. Developers can enable Codex with ZEN_ENABLE_CODEX_RUNTIME=true.'
  )
}
