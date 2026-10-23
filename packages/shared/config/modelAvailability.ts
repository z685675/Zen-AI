export type AvailableModelDescriptor = {
  id: string
  name?: string
  supported_endpoint_types?: Array<
    'openai' | 'openai-response' | 'anthropic' | 'gemini' | 'image-generation' | 'jina-rerank'
  >
}

export type ModelAvailabilitySnapshot = {
  providerId: string
  fingerprint: string
  fetchedAt: number
  models: AvailableModelDescriptor[]
}

/** An explicit complete success, including [], is distinct from a fetch error. */
export function parseAvailableModels(value: unknown): AvailableModelDescriptor[] {
  if (!value || typeof value !== 'object') throw new Error('invalid_model_availability')
  const payload = value as Record<string, unknown>
  if (
    payload.success !== true ||
    payload.object !== 'list' ||
    !Array.isArray(payload.data) ||
    payload.data.length > 20_000
  ) {
    throw new Error('invalid_model_availability')
  }
  const seen = new Set<string>()
  return payload.data.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('invalid_model_availability')
    const model = item as Record<string, unknown>
    if (typeof model.id !== 'string' || !model.id.trim() || model.id.length > 1024 || seen.has(model.id))
      throw new Error('invalid_model_availability')
    seen.add(model.id)
    return {
      id: model.id,
      name: typeof model.name === 'string' ? model.name : undefined,
      supported_endpoint_types: Array.isArray(model.supported_endpoint_types)
        ? model.supported_endpoint_types.filter(
            (type): type is NonNullable<AvailableModelDescriptor['supported_endpoint_types']>[number] =>
              ['openai', 'openai-response', 'anthropic', 'gemini', 'image-generation', 'jina-rerank'].includes(
                type as string
              )
          )
        : undefined
    }
  })
}
