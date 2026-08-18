export type ModelPolicySource = 'remote' | 'cache' | 'builtin'

export interface ModelPolicyDefaults {
  chat: string
  quick: string
  translate: string
  assistant: string
  assistantNewSession: string
}

export interface ModelPolicyAssistant {
  nonDeveloperAllowlist: string[]
  developerAllowlist: string[]
  blockedModels: string[]
  fallbackModels: string[]
}

export interface ModelPolicyRules {
  applyToNewSessions: boolean
  overwriteUserChoice: boolean
  preserveExistingSessions: boolean
  developerModeBypassAllowlist: boolean
}

export interface ModelPolicy {
  schemaVersion: number
  version: number
  updatedAt?: string
  expiresAt?: string
  minClientVersion?: string
  defaults: ModelPolicyDefaults
  assistant: ModelPolicyAssistant
  rules: ModelPolicyRules
}

export interface ModelPolicySnapshot {
  policy: ModelPolicy
  version: number
  etag?: string
  fetchedAt: string
  appliedAt: string
  source: ModelPolicySource
}

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  schemaVersion: 1,
  version: 1,
  defaults: {
    chat: 'gpt-5.6-luna',
    quick: 'gpt-5.6-luna',
    translate: 'gpt-5.6-luna',
    assistant: 'gpt-5.6-luna',
    assistantNewSession: 'gpt-5.6-luna'
  },
  assistant: {
    nonDeveloperAllowlist: ['gpt-5.6-luna', 'grok-4.5', 'gemini-3-flash-preview'],
    developerAllowlist: [],
    blockedModels: [],
    fallbackModels: ['gpt-5.4-mini', 'gpt-5-mini']
  },
  rules: {
    applyToNewSessions: true,
    overwriteUserChoice: false,
    preserveExistingSessions: true,
    developerModeBypassAllowlist: true
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

const isStringArray = (value: unknown): value is string[] => {
  return Array.isArray(value) && value.every(isString)
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

const validateModelList = (value: unknown): value is string[] => {
  if (!isStringArray(value)) return false
  const normalized = value.map((item) => item.trim().toLowerCase())
  return new Set(normalized).size === normalized.length
}

export const isModelPolicy = (value: unknown): value is ModelPolicy => {
  if (!isRecord(value)) return false
  if (value.schemaVersion !== 1 || typeof value.version !== 'number' || !Number.isInteger(value.version)) return false
  if (!isRecord(value.defaults) || !isRecord(value.assistant) || !isRecord(value.rules)) return false

  const defaults = value.defaults
  const assistant = value.assistant
  const rules = value.rules

  if (
    !isString(defaults.chat) ||
    !isString(defaults.quick) ||
    !isString(defaults.translate) ||
    !isString(defaults.assistant) ||
    !isString(defaults.assistantNewSession)
  ) {
    return false
  }

  if (
    !validateModelList(assistant.nonDeveloperAllowlist) ||
    !validateModelList(assistant.developerAllowlist) ||
    !validateModelList(assistant.blockedModels) ||
    !validateModelList(assistant.fallbackModels)
  ) {
    return false
  }

  if (
    !isBoolean(rules.applyToNewSessions) ||
    !isBoolean(rules.overwriteUserChoice) ||
    !isBoolean(rules.preserveExistingSessions) ||
    !isBoolean(rules.developerModeBypassAllowlist)
  ) {
    return false
  }

  if (assistant.nonDeveloperAllowlist.length > 0) {
    const allowed = new Set(assistant.nonDeveloperAllowlist.map((item) => item.toLowerCase()))
    if (!allowed.has(defaults.assistant.toLowerCase()) || !allowed.has(defaults.assistantNewSession.toLowerCase())) {
      return false
    }
  }

  if (assistant.developerAllowlist.length > 0) {
    const allowed = new Set(assistant.developerAllowlist.map((item) => item.toLowerCase()))
    if (!allowed.has(defaults.assistant.toLowerCase())) return false
  }

  const blocked = new Set(assistant.blockedModels.map((item) => item.toLowerCase()))
  if (assistant.fallbackModels.some((item) => blocked.has(item.toLowerCase()))) return false
  if (
    [defaults.chat, defaults.quick, defaults.translate, defaults.assistant, defaults.assistantNewSession].some((item) =>
      blocked.has(item.toLowerCase())
    )
  ) {
    return false
  }

  return true
}

export const normalizeModelPolicy = (value: ModelPolicy): ModelPolicy => ({
  ...value,
  defaults: {
    chat: value.defaults.chat.trim(),
    quick: value.defaults.quick.trim(),
    translate: value.defaults.translate.trim(),
    assistant: value.defaults.assistant.trim(),
    assistantNewSession: value.defaults.assistantNewSession.trim()
  },
  assistant: {
    nonDeveloperAllowlist: value.assistant.nonDeveloperAllowlist.map((item) => item.trim()),
    developerAllowlist: value.assistant.developerAllowlist.map((item) => item.trim()),
    blockedModels: value.assistant.blockedModels.map((item) => item.trim()),
    fallbackModels: value.assistant.fallbackModels.map((item) => item.trim())
  }
})
