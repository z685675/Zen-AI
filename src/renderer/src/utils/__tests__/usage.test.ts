import type { Usage } from '@renderer/types'
import type { LanguageModelUsage } from 'ai'
import { describe, expect, it } from 'vitest'

import { aggregateUsageCacheStats, getUsageCacheStats, normalizeUsage } from '../usage'

describe('usage utils', () => {
  it('normalizes AI SDK usage with cache details', () => {
    const usage: LanguageModelUsage = {
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      inputTokenDetails: {
        cacheReadTokens: 900,
        cacheWriteTokens: 200,
        noCacheTokens: 300
      },
      outputTokenDetails: {
        reasoningTokens: 40,
        textTokens: 260
      }
    }

    expect(normalizeUsage(usage)).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      thoughts_tokens: 40,
      cache_read_tokens: 900,
      cache_write_tokens: 200,
      no_cache_tokens: 300,
      cached_tokens: 900,
      prompt_tokens_details: {
        cached_tokens: 900
      }
    })
  })

  it('reads cached tokens from OpenAI prompt token details', () => {
    const usage: Usage = {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: {
        cached_tokens: 750
      }
    }

    expect(getUsageCacheStats(usage)).toMatchObject({
      promptTokens: 1000,
      cachedTokens: 750,
      hitTokens: 750,
      noCacheTokens: 250,
      hasCache: true
    })
  })

  it('aggregates cache stats across multiple replies', () => {
    const usageA: Usage = {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: {
        cached_tokens: 600
      }
    }
    const usageB: Usage = {
      prompt_tokens: 800,
      completion_tokens: 150,
      total_tokens: 950,
      cache_read_tokens: 500,
      cache_write_tokens: 120,
      no_cache_tokens: 300,
      cached_tokens: 500
    }

    expect(aggregateUsageCacheStats([usageA, usageB])).toMatchObject({
      promptTokens: 1800,
      cacheReadTokens: 500,
      cacheWriteTokens: 120,
      noCacheTokens: 700,
      cachedTokens: 1100,
      hitTokens: 1100,
      hasCache: true
    })
  })
})
