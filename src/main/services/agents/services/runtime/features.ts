const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on'])
const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off'])

export function isCodexRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configuredValue = env.ZEN_ENABLE_CODEX_RUNTIME?.trim().toLowerCase()

  if (configuredValue && ENABLED_VALUES.has(configuredValue)) return true
  if (configuredValue && DISABLED_VALUES.has(configuredValue)) return false

  // Auto must be usable in packaged builds as well. GPT/OpenAI-compatible
  // models rely on Codex as their preferred runtime; keep the environment
  // variable as an explicit opt-out for diagnostics or emergency rollback.
  return true
}

export function getCodexRuntimeDisabledError(): Error {
  return new Error(
    'The Codex runtime candidate is disabled by configuration. Auto will use another available runtime. Remove ZEN_ENABLE_CODEX_RUNTIME=false to re-enable Codex.'
  )
}
