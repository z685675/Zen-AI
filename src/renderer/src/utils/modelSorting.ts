import type { Model } from '@renderer/types'

const modelNameCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base'
})

const MODEL_FAMILY_TOKENS = [
  ['gpt', 'openai'],
  ['gemini', 'google'],
  ['claude', 'anthropic'],
  ['grok', 'xai']
] as const

type SortableModel = Pick<Model, 'group' | 'id' | 'name'>

const tokenize = (value: string): Set<string> =>
  new Set(
    value
      .trim()
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  )

/** GPT -> Gemini -> Claude -> Grok -> all remaining model families. */
export const getModelFamilyPriority = (model: SortableModel): number => {
  const identifierTokens = tokenize(`${model.id} ${model.name}`)
  const explicitPriority = MODEL_FAMILY_TOKENS.findIndex(([familyToken]) => identifierTokens.has(familyToken))
  if (explicitPriority !== -1) return explicitPriority

  const groupTokens = tokenize(model.group)
  const groupPriority = MODEL_FAMILY_TOKENS.findIndex((familyTokens) =>
    familyTokens.some((token) => groupTokens.has(token))
  )
  return groupPriority === -1 ? MODEL_FAMILY_TOKENS.length : groupPriority
}

export const compareModelsByFamily = (left: SortableModel, right: SortableModel): number => {
  const familyPriority = getModelFamilyPriority(left) - getModelFamilyPriority(right)
  if (familyPriority !== 0) return familyPriority

  const idOrder = modelNameCollator.compare(left.id.trim(), right.id.trim())
  if (idOrder !== 0) return idOrder

  const nameOrder = modelNameCollator.compare(left.name.trim(), right.name.trim())
  if (nameOrder !== 0) return nameOrder

  return modelNameCollator.compare(left.group.trim(), right.group.trim())
}

export const sortModelsByFamily = <T extends SortableModel>(models: readonly T[]): T[] =>
  [...models].sort(compareModelsByFamily)

export const sortModelGroupsByFamily = <T extends SortableModel>(groups: Record<string, T[]>): Record<string, T[]> => {
  const sortedEntries = Object.entries(groups).map(([groupName, models]) => [
    groupName,
    sortModelsByFamily(models)
  ]) as Array<[string, T[]]>

  sortedEntries.sort(([leftGroup, leftModels], [rightGroup, rightModels]) => {
    const leftFirst = leftModels[0]
    const rightFirst = rightModels[0]

    if (leftFirst && rightFirst) {
      const modelOrder = compareModelsByFamily(leftFirst, rightFirst)
      if (modelOrder !== 0) return modelOrder
    } else if (leftFirst) {
      return -1
    } else if (rightFirst) {
      return 1
    }

    return modelNameCollator.compare(leftGroup, rightGroup)
  })

  return Object.fromEntries(sortedEntries)
}
