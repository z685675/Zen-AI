import builtin from './config/modelCapacitySnapshot.json'

export type ModelCapacity = { context: number; input?: number; output?: number }
export type ModelCapacityCatalog = {
  schemaVersion: 1
  updatedAt: string
  models: Record<string, ModelCapacity>
}

export const MODEL_CAPACITY_SOURCE_ENDPOINT = 'https://models.dev/models.json'
export const MODEL_CAPACITY_ENDPOINT = 'https://zenai.925636.xyz/api/client/model-capacity-catalog'
export const MODEL_CAPACITY_IPC = 'model-capacity:get'
// oxlint-disable-next-line no-control-regex -- Control characters are invalid in model identifiers.
const CANONICAL_ID = /^[a-z0-9][a-z0-9._-]*\/[^\s\u0000-\u001f]+$/i

export function normalizeTokenLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return undefined
  const tokens = Math.floor(value)
  return Number.isSafeInteger(tokens) ? tokens : undefined
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Only capacity facts from the canonical catalog are retained. No prices or model instructions. */
export function normalizeModelCapacityCatalog(value: unknown, updatedAt: string): ModelCapacityCatalog {
  const models: Record<string, ModelCapacity> = {}
  for (const [id, item] of Object.entries(record(value) ?? {})) {
    if (id.length > 256 || !CANONICAL_ID.test(id)) continue
    const limit = record(record(item)?.limit)
    const context = normalizeTokenLimit(limit?.context)
    if (!context) continue
    const input = normalizeTokenLimit(limit?.input)
    const output = normalizeTokenLimit(limit?.output)
    models[id] = { context, ...(input ? { input: Math.min(context, input) } : {}), ...(output ? { output } : {}) }
  }
  if (!Object.keys(models).length) throw new Error('Model capacity catalog contains no valid context limits')
  return { schemaVersion: 1, updatedAt, models }
}

export function validateModelCapacityCatalog(value: unknown): value is ModelCapacityCatalog {
  const catalog = record(value)
  if (
    catalog?.schemaVersion !== 1 ||
    typeof catalog.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(catalog.updatedAt))
  )
    return false
  const models = record(catalog.models)
  return Boolean(
    models &&
      Object.keys(models).length &&
      Object.entries(models).every(([id, value]) => {
        const limit = record(value)
        return (
          id.length <= 256 &&
          CANONICAL_ID.test(id) &&
          Boolean(normalizeTokenLimit(limit?.context)) &&
          normalizeTokenLimit(limit?.context) === limit?.context &&
          (limit?.input === undefined ||
            (normalizeTokenLimit(limit.input) === limit.input &&
              (limit.input as number) <= (limit.context as number))) &&
          (limit?.output === undefined || normalizeTokenLimit(limit.output) === limit.output)
        )
      })
  )
}

export const BUILTIN_MODEL_CAPACITY_CATALOG = builtin as ModelCapacityCatalog
let catalog = BUILTIN_MODEL_CAPACITY_CATALOG
let aliases = buildAliases(catalog)

function buildAliases(value: ModelCapacityCatalog) {
  const entries = new Map<string, ModelCapacity | null>()
  for (const [id, capacity] of Object.entries(value.models)) {
    const name = id.slice(id.indexOf('/') + 1)
    // An ambiguous name must not inherit some other manufacturer's capacity.
    entries.set(name, entries.has(name) ? null : capacity)
  }
  return entries
}

export function setModelCapacityCatalog(value: ModelCapacityCatalog): void {
  if (!validateModelCapacityCatalog(value)) throw new Error('Invalid model capacity catalog')
  catalog = { ...value, models: { ...BUILTIN_MODEL_CAPACITY_CATALOG.models, ...value.models } }
  aliases = buildAliases(catalog)
}

export function getModelCatalogCapacity(id?: string): ModelCapacity | undefined {
  if (!id) return undefined
  // Match exact canonical IDs or unique API IDs, never model families/display names.
  return Object.hasOwn(catalog.models, id) ? catalog.models[id] : (aliases.get(id) ?? undefined)
}

export type ModelTokenMetadata = {
  id?: string
  provider?: string
  contextWindowTokens?: number
  maxOutputTokens?: number
  contextCapacitySource?: string
}

export function usesCatalogContext(model?: ModelTokenMetadata): boolean {
  return Boolean(
    getModelCatalogCapacity(model?.id) &&
      (!normalizeTokenLimit(model?.contextWindowTokens) ||
        model?.contextCapacitySource === 'builtin' ||
        model?.contextCapacitySource === 'fallback')
  )
}
