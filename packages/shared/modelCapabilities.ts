import { normalizeTokenLimit } from './modelCapacity'

/** Absent values are unknown; false and [] are explicit declarations. */
export type ModelCapabilities = {
  canonical_id?: string
  context_length?: number
  max_input_tokens?: number
  max_output_tokens?: number
  tools?: boolean
  structured_output?: boolean
  reasoning?: boolean
  temperature?: boolean
  input_modalities?: string[]
  output_modalities?: string[]
  reasoning_efforts?: string[]
  source?: string
  updated_at?: string
}

const registry = new Map<string, Map<string, ModelCapabilities>>()
export function parseModelCapabilities(value: unknown): ModelCapabilities | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const result: ModelCapabilities = {}
  for (const key of ['context_length', 'max_input_tokens', 'max_output_tokens'] as const) {
    const limit = normalizeTokenLimit(raw[key])
    if (limit) result[key] = limit
  }
  for (const key of ['tools', 'structured_output', 'reasoning', 'temperature'] as const) {
    if (typeof raw[key] === 'boolean') result[key] = raw[key]
  }
  for (const key of ['canonical_id', 'source', 'updated_at'] as const) {
    if (typeof raw[key] === 'string' && raw[key].length <= 256) result[key] = raw[key]
  }
  for (const key of ['input_modalities', 'output_modalities', 'reasoning_efforts'] as const) {
    const values = raw[key]
    if (
      Array.isArray(values) &&
      values.length <= 16 &&
      values.every(
        (v) =>
          typeof v === 'string' &&
          v.length <= 32 &&
          (key === 'reasoning_efforts' || ['text', 'image', 'audio', 'video', 'pdf'].includes(v))
      )
    )
      result[key] = [...new Set(values as string[])]
  }
  if (result.context_length) {
    if (result.max_input_tokens) result.max_input_tokens = Math.min(result.max_input_tokens, result.context_length)
    if (result.max_output_tokens) result.max_output_tokens = Math.min(result.max_output_tokens, result.context_length)
  }
  return Object.keys(result).length ? result : undefined
}

export function setProviderModelCapabilities(
  providerId: string,
  models: Array<{ id: string; model_capabilities?: ModelCapabilities }>
): void {
  registry.set(providerId, new Map(models.flatMap((m) => (m.model_capabilities ? [[m.id, m.model_capabilities]] : []))))
}
export function registerModelCapabilities(providerId: string, modelId: string, value: unknown): void {
  const models = registry.get(providerId) ?? new Map<string, ModelCapabilities>()
  const parsed = parseModelCapabilities(value)
  if (parsed) models.set(modelId, parsed)
  else models.delete(modelId)
  registry.set(providerId, models)
}
export function getModelCapabilities(model?: { id?: string; provider?: string } | null): ModelCapabilities | undefined {
  return model?.provider && model.id ? registry.get(model.provider)?.get(model.id) : undefined
}

/** Every rotation key must support the advertised feature/limit. */
export function intersectModelCapabilities(
  values: Array<ModelCapabilities | undefined>
): ModelCapabilities | undefined {
  if (!values.length) return undefined
  const result = { ...values[0] }
  for (const value of values.slice(1)) {
    if (result.canonical_id !== value?.canonical_id) result.canonical_id = undefined
    for (const key of ['context_length', 'max_input_tokens', 'max_output_tokens'] as const)
      result[key] = result[key] && value?.[key] ? Math.min(result[key], value[key]) : undefined
    for (const key of ['tools', 'structured_output', 'reasoning', 'temperature'] as const)
      result[key] =
        result[key] === false || value?.[key] === false
          ? false
          : result[key] === true && value?.[key] === true
            ? true
            : undefined
    for (const key of ['input_modalities', 'output_modalities', 'reasoning_efforts'] as const)
      result[key] = result[key] && value?.[key] ? result[key].filter((v) => value[key]?.includes(v)) : undefined
  }
  return Object.values(result).some((value) => value !== undefined) ? result : undefined
}

export function modelCapacityFields(value?: ModelCapabilities) {
  return value?.context_length || value?.max_output_tokens
    ? {
        contextWindowTokens: value.context_length,
        maxOutputTokens: value.max_output_tokens,
        contextCapacitySource: 'provider' as const,
        contextCapacityConfidence: 'high' as const
      }
    : {}
}
