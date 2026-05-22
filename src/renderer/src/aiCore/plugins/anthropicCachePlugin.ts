/**
 * Anthropic Prompt Caching Middleware
 * @see https://ai-sdk.dev/providers/ai-sdk-providers/anthropic#cache-control
 */
import type { LanguageModelV3Message } from '@ai-sdk/provider'
import { definePlugin } from '@cherrystudio/ai-core/core/plugins'
import { estimateTextTokens } from '@renderer/services/TokenService'
import type { AnthropicCacheControlSettings } from '@renderer/types/provider'
import type { LanguageModelMiddleware } from 'ai'

const cacheProviderOptions = {
  anthropic: { cacheControl: { type: 'ephemeral' } }
}

// Anthropic prompt caching works best with a small number of stable breakpoints.
const MAX_CACHE_BREAKPOINTS = 4

export type CacheCandidate = {
  index: number
  contentParts: number
}

function estimateContentTokens(content: LanguageModelV3Message['content']): number {
  if (typeof content === 'string') return estimateTextTokens(content)
  if (Array.isArray(content)) {
    return content.reduce((acc, part) => {
      if (part.type === 'text') {
        return acc + estimateTextTokens(part.text)
      }
      return acc
    }, 0)
  }
  return 0
}

function countContentParts(content: LanguageModelV3Message['content']): number {
  if (typeof content === 'string') {
    return content.trim() ? 1 : 0
  }
  if (Array.isArray(content)) {
    return content.length
  }
  return 0
}

function markMessageForCache(messages: LanguageModelV3Message[], index: number): void {
  const message = messages[index]

  if (!message) {
    return
  }

  if (message.role === 'system' || typeof message.content === 'string') {
    messages[index] = { ...message, providerOptions: cacheProviderOptions }
    return
  }

  if (!Array.isArray(message.content) || message.content.length === 0) {
    return
  }

  const content = [...message.content]
  const lastIndex = content.length - 1
  content[lastIndex] = {
    ...content[lastIndex],
    providerOptions: cacheProviderOptions
  }

  messages[index] = {
    ...message,
    content
  } as LanguageModelV3Message
}

export function selectStableConversationCacheIndices(candidates: CacheCandidate[], slots: number): number[] {
  if (slots <= 0 || candidates.length === 0) {
    return []
  }

  if (candidates.length <= slots) {
    return candidates.map((candidate) => candidate.index)
  }

  if (slots === 1) {
    return [candidates[candidates.length - 1].index]
  }

  const totalParts = candidates.reduce((sum, candidate) => sum + candidate.contentParts, 0)
  const selected = new Set<number>()
  let accumulatedParts = 0
  let nextTarget = totalParts / slots

  for (const candidate of candidates) {
    accumulatedParts += candidate.contentParts

    if (selected.size < slots - 1 && accumulatedParts >= nextTarget) {
      selected.add(candidate.index)
      nextTarget = (totalParts / slots) * (selected.size + 1)
    }
  }

  selected.add(candidates[candidates.length - 1].index)

  if (selected.size < slots) {
    for (let i = candidates.length - 1; i >= 0 && selected.size < slots; i--) {
      selected.add(candidates[i].index)
    }
  }

  return candidates.filter((candidate) => selected.has(candidate.index)).map((candidate) => candidate.index)
}

export function selectAnthropicCacheBreakpointIndices(
  prompt: LanguageModelV3Message[],
  settings: AnthropicCacheControlSettings
): number[] {
  const { tokenThreshold, cacheSystemMessage, cacheLastNMessages } = settings

  if (!tokenThreshold || prompt.length === 0) {
    return []
  }

  let cumulativeTokens = 0
  let systemIndex: number | undefined
  const eligibleNonSystemCandidates: CacheCandidate[] = []

  for (let i = 0; i < prompt.length; i++) {
    const message = prompt[i]
    const tokens = estimateContentTokens(message.content)
    const contentParts = countContentParts(message.content)

    cumulativeTokens += tokens

    if (contentParts === 0) {
      continue
    }

    if (message.role === 'system') {
      if (cacheSystemMessage && systemIndex === undefined && tokens >= tokenThreshold) {
        systemIndex = i
      }
      continue
    }

    if (cumulativeTokens >= tokenThreshold) {
      eligibleNonSystemCandidates.push({
        index: i,
        contentParts
      })
    }
  }

  if (eligibleNonSystemCandidates.length === 0) {
    return systemIndex === undefined ? [] : [systemIndex]
  }

  const reservedSystemSlots = systemIndex === undefined ? 0 : 1
  const maxRecentByCandidates = Math.max(eligibleNonSystemCandidates.length - 1, 0)
  const maxRecentBySlots = Math.max(MAX_CACHE_BREAKPOINTS - reservedSystemSlots - 1, 0)
  const recentCount = cacheLastNMessages > 0 ? Math.min(cacheLastNMessages, maxRecentByCandidates, maxRecentBySlots) : 0

  const recentCandidates = recentCount > 0 ? eligibleNonSystemCandidates.slice(-recentCount) : []
  const recentIndices = recentCandidates.map((candidate) => candidate.index)
  const recentSet = new Set(recentIndices)
  const stableCandidates = eligibleNonSystemCandidates.filter((candidate) => !recentSet.has(candidate.index))
  const stableSlots = Math.max(MAX_CACHE_BREAKPOINTS - reservedSystemSlots - recentIndices.length, 0)
  const stableIndices = selectStableConversationCacheIndices(stableCandidates, stableSlots)

  return [...new Set([systemIndex, ...stableIndices, ...recentIndices].filter((index) => index !== undefined))]
}

export function applyAnthropicPromptCaching(
  prompt: LanguageModelV3Message[],
  settings: AnthropicCacheControlSettings
): LanguageModelV3Message[] {
  const breakpointIndices = selectAnthropicCacheBreakpointIndices(prompt, settings)

  if (breakpointIndices.length === 0) {
    return prompt
  }

  const messages = [...prompt]
  for (const index of breakpointIndices) {
    markMessageForCache(messages, index)
  }

  return messages
}

function anthropicCacheMiddleware(settings: AnthropicCacheControlSettings): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      if (!settings.tokenThreshold || !Array.isArray(params.prompt) || params.prompt.length === 0) {
        return params
      }

      return {
        ...params,
        prompt: applyAnthropicPromptCaching(params.prompt, settings)
      }
    }
  }
}

export const createAnthropicCachePlugin = (settings: AnthropicCacheControlSettings) =>
  definePlugin({
    name: 'anthropicCache',
    enforce: 'pre',
    configureContext: (context) => {
      context.middlewares = context.middlewares || []
      context.middlewares.push(anthropicCacheMiddleware(settings))
    }
  })
