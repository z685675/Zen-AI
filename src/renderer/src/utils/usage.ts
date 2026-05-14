import type { Usage } from '@renderer/types'
import type { LanguageModelUsage } from 'ai'

type UsageLike = Usage | LanguageModelUsage | undefined | null

export interface UsageCacheStats {
  promptTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  noCacheTokens: number
  cachedTokens: number
  hitTokens: number
  hasCache: boolean
  hitRate?: number
}

function isLanguageModelUsage(usage: Usage | LanguageModelUsage): usage is LanguageModelUsage {
  return 'inputTokens' in usage
}

export function normalizeUsage(usage?: UsageLike): Usage | undefined {
  if (!usage) {
    return undefined
  }

  if (isLanguageModelUsage(usage)) {
    const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens
    const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens
    const noCacheTokens = usage.inputTokenDetails?.noCacheTokens
    const cachedTokens = cacheReadTokens

    return {
      prompt_tokens: usage.inputTokens ?? 0,
      completion_tokens: usage.outputTokens ?? 0,
      total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      thoughts_tokens: usage.outputTokenDetails?.reasoningTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      no_cache_tokens: noCacheTokens,
      cached_tokens: cachedTokens,
      prompt_tokens_details:
        cachedTokens !== undefined
          ? {
              cached_tokens: cachedTokens
            }
          : undefined
    }
  }

  const cachedTokens = usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens

  return {
    ...usage,
    cached_tokens: cachedTokens,
    prompt_tokens_details:
      cachedTokens !== undefined
        ? {
            ...usage.prompt_tokens_details,
            cached_tokens: cachedTokens
          }
        : usage.prompt_tokens_details
  }
}

export function getUsageCacheStats(usage?: UsageLike): UsageCacheStats {
  const normalizedUsage = normalizeUsage(usage)

  if (!normalizedUsage) {
    return {
      promptTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
      cachedTokens: 0,
      hitTokens: 0,
      hasCache: false
    }
  }

  const promptTokens = normalizedUsage.prompt_tokens ?? 0
  const cacheReadTokens = normalizedUsage.cache_read_tokens ?? 0
  const cacheWriteTokens = normalizedUsage.cache_write_tokens ?? 0
  const cachedTokens = normalizedUsage.cached_tokens ?? normalizedUsage.prompt_tokens_details?.cached_tokens ?? 0
  const hitTokens = Math.max(cacheReadTokens, cachedTokens)
  const hasCacheSignals =
    normalizedUsage.cache_read_tokens !== undefined ||
    normalizedUsage.cache_write_tokens !== undefined ||
    normalizedUsage.no_cache_tokens !== undefined ||
    normalizedUsage.cached_tokens !== undefined ||
    normalizedUsage.prompt_tokens_details?.cached_tokens !== undefined
  const noCacheTokens = normalizedUsage.no_cache_tokens ?? (hasCacheSignals ? Math.max(promptTokens - hitTokens, 0) : 0)
  const hasCache = hasCacheSignals

  const denominator = hitTokens + noCacheTokens

  return {
    promptTokens,
    cacheReadTokens,
    cacheWriteTokens,
    noCacheTokens,
    cachedTokens,
    hitTokens,
    hasCache,
    hitRate: denominator > 0 ? hitTokens / denominator : undefined
  }
}

export function aggregateUsageCacheStats(usages: UsageLike[]): UsageCacheStats {
  const totals = usages.reduce<UsageCacheStats>(
    (acc, usage) => {
      const stats = getUsageCacheStats(usage)
      acc.promptTokens += stats.promptTokens
      acc.cacheReadTokens += stats.cacheReadTokens
      acc.cacheWriteTokens += stats.cacheWriteTokens
      acc.noCacheTokens += stats.noCacheTokens
      acc.cachedTokens += stats.cachedTokens
      acc.hitTokens += stats.hitTokens
      acc.hasCache = acc.hasCache || stats.hasCache
      return acc
    },
    {
      promptTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
      cachedTokens: 0,
      hitTokens: 0,
      hasCache: false
    }
  )

  const denominator = totals.hitTokens + totals.noCacheTokens

  return {
    ...totals,
    hitRate: denominator > 0 ? totals.hitTokens / denominator : undefined
  }
}

export function formatTokenCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

export function formatTokenCountCompact(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: value >= 100000 ? 0 : 1
  }).format(value)
}
