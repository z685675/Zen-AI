import { afterEach, describe, expect, it } from 'vitest'

import {
  BUILTIN_MODEL_CAPACITY_CATALOG,
  getModelCatalogCapacity,
  normalizeModelCapacityCatalog,
  setModelCapacityCatalog,
  validateModelCapacityCatalog
} from '../modelCapacity'
import { resolveModelTokenLimits } from '../utils/modelTokenLimits'

const reference = { context: 1_000_000, input: 900_000, output: 100_000 }
const install = () =>
  setModelCapacityCatalog({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    models: { 'test-lab/catalog-model': reference }
  })

afterEach(() => setModelCapacityCatalog(BUILTIN_MODEL_CAPACITY_CATALOG))

describe('model capacity catalog', () => {
  it('ships a valid offline snapshot with separate input and output facts', () => {
    expect(validateModelCapacityCatalog(BUILTIN_MODEL_CAPACITY_CATALOG)).toBe(true)
    expect(Object.keys(BUILTIN_MODEL_CAPACITY_CATALOG.models).length).toBeGreaterThan(100)
    expect(getModelCatalogCapacity('openai/gpt-6.1-sol')).toEqual(getModelCatalogCapacity('gpt-6.1-sol'))
  })

  it('accepts canonical numeric limits while rejecting prices, zero, strings, malformed names and absent context', () => {
    const result = normalizeModelCapacityCatalog(
      {
        'test-lab/catalog-model': { limit: reference, description: 'ignore this', price: 100 },
        'test-lab/bad': { limit: { context: '1000000', output: 42 } },
        'test-lab/zero': { limit: { context: 0 } },
        'test-lab/output-only': { limit: { output: 5000 } },
        arbitrary: { limit: reference }
      },
      new Date().toISOString()
    )
    expect(result.models).toEqual({ 'test-lab/catalog-model': reference })
    expect(() => normalizeModelCapacityCatalog({ error: 'unavailable' }, result.updatedAt)).toThrow()
    expect(validateModelCapacityCatalog({ ...result, models: { 'test-lab/bad': {} } })).toBe(false)
  })

  it('matches exact canonical or unique API IDs without assigning capacities to family-like aliases', () => {
    install()
    expect(getModelCatalogCapacity('catalog-model')).toEqual(reference)
    expect(getModelCatalogCapacity('test-lab/catalog-model')).toEqual(reference)
    expect(getModelCatalogCapacity('catalog-model-new')).toBeUndefined()
    expect(getModelCatalogCapacity('GPT-6.1 Sol')).toBeUndefined()
    setModelCapacityCatalog({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      models: { 'test-lab/duplicate': reference, 'other-lab/duplicate': { context: 8000 } }
    })
    expect(getModelCatalogCapacity('duplicate')).toBeUndefined()
    expect(getModelCatalogCapacity('other-lab/duplicate')?.context).toBe(8000)
  })

  it('uses the catalog for unknown metadata without an arbitrary 200K ceiling', () => {
    install()
    expect(resolveModelTokenLimits({ id: 'catalog-model' })).toEqual(reference)
    expect(resolveModelTokenLimits({ id: 'unlisted-model' })).toEqual({ context: 128_000, output: 16_000 })
  })

  it.each(['user', 'provider', undefined])('preserves explicit %s capacities rather than replacing them', (source) => {
    install()
    expect(
      resolveModelTokenLimits({
        id: 'catalog-model',
        contextWindowTokens: 64_000,
        maxOutputTokens: 4_000,
        contextCapacitySource: source
      })
    ).toEqual({ context: 64_000, output: 4_000 })
  })

  it.each(['builtin', 'fallback'])('refreshes %s values without retaining an obsolete default', (source) => {
    install()
    expect(
      resolveModelTokenLimits({
        id: 'catalog-model',
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        contextCapacitySource: source
      })
    ).toEqual(reference)
  })
})
