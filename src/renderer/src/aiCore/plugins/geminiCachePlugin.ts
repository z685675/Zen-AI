import type { LanguageModelV3CallOptions, LanguageModelV3Message, LanguageModelV3TextPart } from '@ai-sdk/provider'
import { definePlugin } from '@cherrystudio/ai-core/core/plugins'
import { createModelContent, createPartFromText, createUserContent, GoogleGenAI } from '@google/genai'
import { estimateTextTokens } from '@renderer/services/TokenService'
import type { GeminiCacheControlSettings } from '@renderer/types/provider'
import type { LanguageModelMiddleware } from 'ai'

type GeminiCacheEntry = {
  cachedContent: string
  expiresAt: number
}

type GeminiCacheCandidate = {
  cacheKey: string
  prefixMessages: LanguageModelV3Message[]
  tailMessages: LanguageModelV3Message[]
  prefixTokens: number
}

const geminiCacheStore = new Map<string, GeminiCacheEntry>()
const MAX_TAIL_MESSAGES = 4
const MIN_STABLE_MESSAGES = 2

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function getMessageText(message: LanguageModelV3Message): string {
  if (typeof message.content === 'string') {
    return normalizeText(message.content)
  }

  if (!Array.isArray(message.content)) {
    return ''
  }

  return normalizeText(
    message.content
      .filter((part): part is LanguageModelV3TextPart => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
  )
}

function isTextOnlyMessage(message: LanguageModelV3Message): boolean {
  if (typeof message.content === 'string') {
    return true
  }

  return Array.isArray(message.content) && message.content.every((part) => part.type === 'text')
}

function isCacheEligiblePrompt(prompt: LanguageModelV3Message[]): boolean {
  return prompt.every((message) => isTextOnlyMessage(message))
}

function stringifyMessage(message: LanguageModelV3Message): string {
  const text = getMessageText(message)
  return `${message.role}:${text}`
}

function buildStablePrefixKey(modelId: string, prefixMessages: LanguageModelV3Message[]): string {
  return ['zen-gemini-cache', modelId, ...prefixMessages.map((message) => stringifyMessage(message))].join('\n')
}

function getEffectivePrefixThreshold(settings: GeminiCacheControlSettings): number {
  if (!settings.tokenThreshold || settings.tokenThreshold <= 0) {
    return 0
  }

  if (settings.tokenThreshold <= 32) {
    return settings.tokenThreshold
  }

  return Math.max(64, Math.floor(settings.tokenThreshold * 0.75))
}

function isStableCacheRole(role: LanguageModelV3Message['role']): boolean {
  return role === 'system' || role === 'user' || role === 'assistant'
}

function buildGeminiCacheContents(prefixMessages: LanguageModelV3Message[]) {
  return prefixMessages.flatMap((message) => {
    const text = getMessageText(message)
    if (!text) {
      return []
    }

    if (message.role === 'assistant') {
      return [createModelContent([createPartFromText(text)])]
    }

    return [createUserContent([createPartFromText(text)])]
  })
}

export function selectGeminiCacheCandidate(
  prompt: LanguageModelV3Message[],
  settings: GeminiCacheControlSettings,
  modelId: string
): GeminiCacheCandidate | undefined {
  if (!settings.enabled || !settings.tokenThreshold || prompt.length < MIN_STABLE_MESSAGES + 1) {
    return undefined
  }

  if (!isCacheEligiblePrompt(prompt)) {
    return undefined
  }

  const effectiveThreshold = getEffectivePrefixThreshold(settings)
  const lastCacheableIndex = prompt.length - 1
  let bestCandidate: GeminiCacheCandidate | undefined

  for (let prefixLength = MIN_STABLE_MESSAGES; prefixLength <= lastCacheableIndex; prefixLength++) {
    const tailMessages = prompt.slice(prefixLength)

    if (tailMessages.length === 0 || tailMessages.length > MAX_TAIL_MESSAGES) {
      continue
    }

    const prefixMessages = prompt.slice(0, prefixLength)
    const cacheablePrefixMessages = prefixMessages.filter((message) => isStableCacheRole(message.role))
    if (cacheablePrefixMessages.length < MIN_STABLE_MESSAGES) {
      continue
    }

    const prefixText = prefixMessages.map((message) => stringifyMessage(message)).join('\n')
    const prefixTokens = estimateTextTokens(prefixText)

    if (prefixTokens < effectiveThreshold) {
      continue
    }

    bestCandidate = {
      cacheKey: buildStablePrefixKey(modelId, cacheablePrefixMessages),
      prefixMessages: cacheablePrefixMessages,
      tailMessages,
      prefixTokens
    }
  }

  return bestCandidate
}

async function resolveGeminiCachedContent(
  cacheKey: string,
  apiKey: string,
  modelId: string,
  prefixMessages: LanguageModelV3Message[],
  ttlSeconds: number
): Promise<string | undefined> {
  const cached = geminiCacheStore.get(cacheKey)

  if (cached && cached.expiresAt > Date.now()) {
    return cached.cachedContent
  }

  const contents = buildGeminiCacheContents(prefixMessages)
  if (contents.length === 0) {
    return undefined
  }

  const ai = new GoogleGenAI({ apiKey })
  const created = await ai.caches.create({
    model: modelId,
    config: {
      ttl: `${ttlSeconds}s`,
      contents
    }
  })

  if (!created.name) {
    return undefined
  }

  geminiCacheStore.set(cacheKey, {
    cachedContent: created.name,
    expiresAt: Date.now() + ttlSeconds * 1000
  })

  return created.name
}

function geminiCacheMiddleware(settings: GeminiCacheControlSettings): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      if (!settings.enabled || !Array.isArray(params.prompt) || params.prompt.length === 0) {
        return params
      }

      const paramsWithModel = params as LanguageModelV3CallOptions & { model?: string }
      const modelId = typeof paramsWithModel.model === 'string' ? paramsWithModel.model : ''
      if (!modelId) {
        return params
      }

      const cacheCandidate = selectGeminiCacheCandidate(params.prompt, settings, modelId)
      if (!cacheCandidate) {
        return params
      }

      const headers = params.headers || {}
      const apiKey = headers['x-goog-api-key']
      if (!apiKey) {
        return params
      }

      const cachedContent = await resolveGeminiCachedContent(
        cacheCandidate.cacheKey,
        apiKey,
        modelId,
        cacheCandidate.prefixMessages,
        settings.ttlSeconds
      )

      if (!cachedContent) {
        return params
      }

      const googleOptions = (params.providerOptions?.google as Record<string, unknown> | undefined) || {}

      return {
        ...params,
        prompt: cacheCandidate.tailMessages,
        providerOptions: {
          ...params.providerOptions,
          google: {
            ...googleOptions,
            cachedContent
          }
        }
      }
    }
  }
}

export const createGeminiCachePlugin = (settings: GeminiCacheControlSettings) =>
  definePlugin({
    name: 'geminiCache',
    enforce: 'pre',
    configureContext: (context) => {
      context.middlewares = context.middlewares || []
      context.middlewares.push(geminiCacheMiddleware(settings))
    }
  })
