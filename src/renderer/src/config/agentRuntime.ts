const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on'])

export const isCodexRuntimeEnabled =
  import.meta.env.DEV || ENABLED_VALUES.has(import.meta.env.VITE_ENABLE_CODEX_RUNTIME?.trim().toLowerCase() ?? '')
