import { getModelCapabilities } from '../modelCapabilities'
import {
  getModelCatalogCapacity,
  type ModelTokenMetadata,
  normalizeTokenLimit,
  usesCatalogContext
} from '../modelCapacity'

export { normalizeTokenLimit } from '../modelCapacity'

/**
 * Preserve provider/user capacities. Defaults are only for unknown models,
 * not ceilings on models that advertise a larger window or output limit.
 */
export function resolveModelTokenLimits(
  model: ModelTokenMetadata | undefined,
  defaults = { context: 128_000, output: 16_000 }
): { context: number; input?: number; output: number } {
  const reference = getModelCatalogCapacity(model?.id)
  const supplied = getModelCapabilities(model)
  const useSupplied = model?.contextCapacitySource !== 'user' && model?.contextCapacitySource !== 'adaptive'
  const useCatalog = usesCatalogContext(model)
  const context =
    (useSupplied ? supplied?.context_length : undefined) ??
    (useCatalog ? reference?.context : normalizeTokenLimit(model?.contextWindowTokens)) ??
    defaults.context
  const inputReserve = Math.min(1_024, Math.max(1, Math.floor(context / 2)))
  const output = Math.min(
    (useSupplied ? supplied?.max_output_tokens : undefined) ??
      (model?.contextCapacitySource === 'builtin' || model?.contextCapacitySource === 'fallback'
        ? (reference?.output ?? normalizeTokenLimit(model?.maxOutputTokens))
        : normalizeTokenLimit(model?.maxOutputTokens)) ??
      reference?.output ??
      defaults.output,
    Math.max(1, context - inputReserve)
  )
  const input = (useSupplied ? supplied?.max_input_tokens : undefined) ?? (useCatalog ? reference?.input : undefined)
  return { context, ...(input ? { input: Math.min(context, input) } : {}), output }
}
