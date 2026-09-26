import type { LanguageModelV3CallOptions, LanguageModelV3Message, LanguageModelV3TextPart } from '@ai-sdk/provider'
import { definePlugin } from '@cherrystudio/ai-core/core/plugins'
import { createModelContent, createPartFromText, createUserContent, GoogleGenAI } from '@google/genai'
import { loggerService } from '@logger'
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
const geminiCacheFailureStore = new Map<string, number>()
const MAX_TAIL_MESSAGES = 4
const MIN_STABLE_MESSAGES = 2
const CACHE_FAILURE_RETRY_COOLDOWN_MS = 60_000
const logger = loggerService.withContext('GeminiCachePlugin')

export type GeminiCacheClientOptions = {
  apiKey?: string
  baseURL?: string
  headers?: Record<string, string>
}

function getMessageText(message: LanguageModelV3Message): string {
  if (typeof message.content === 'string') {
    return message.content
  }

  if (!Array.isArray(message.content)) {
    return ''
  }

  return message.content
    .filter((part): part is LanguageModelV3TextPart => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function isTextOnlyMessage(message: LanguageModelV3Message): boolean {
  if (typeof message.content === 'string') {
    return true
  }

  return Array.isArray(message.content) && message.content.every((part) => part.type === 'text')
}

function isCacheEligiblePrompt(prompt: LanguageModelV3Message[]): boolean {
  return prompt.every(
    (message) =>
      isTextOnlyMessage(message) &&
      (message.role === 'system' || message.role === 'user' || message.role === 'assistant')
  )
}

function stringifyMessage(message: LanguageModelV3Message): string {
  const text = getMessageText(message)
  return `${message.role}:${text}`
}

function hashCacheScope(value: string): string {
  let hash = 2166136261
  for (const char of value) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function buildStablePrefixKey(
  modelId: string,
  prefixMessages: LanguageModelV3Message[],
  cacheScope = '',
  ttlSeconds = 0
): string {
  return [
    'zen-gemini-cache',
    modelId,
    cacheScope ? `scope-${hashCacheScope(cacheScope)}` : '',
    ttlSeconds > 0 ? `ttl-${ttlSeconds}` : '',
    ...prefixMessages.map((message) => stringifyMessage(message))
  ]
    .filter(Boolean)
    .join('\n')
}

function getEffectivePrefixThreshold(settings: GeminiCacheControlSettings): number {
  if (!settings.tokenThreshold || settings.tokenThreshold <= 0) {
    return 0
  }

  // Do not call the cache API before its configured/model-specific minimum.
  // A rejected under-sized cache can otherwise recur every time the prefix
  // grows, wasting requests without ever improving the conversation cache.
  return settings.tokenThreshold
}

function isStableCacheRole(role: LanguageModelV3Message['role']): boolean {
  return role === 'system' || role === 'user' || role === 'assistant'
}

function buildGeminiCacheContents(prefixMessages: LanguageModelV3Message[]) {
  return prefixMessages.flatMap((message) => {
    if (message.role === 'system') {
      return []
    }

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

function buildGeminiSystemInstruction(prefixMessages: LanguageModelV3Message[]) {
  const text = prefixMessages
    .filter((message) => message.role === 'system')
    .map(getMessageText)
    .filter(Boolean)
    .join('\n\n')

  return text ? createUserContent([createPartFromText(text)]) : undefined
}

function normalizeCacheApiBaseUrl(baseURL?: string): string | undefined {
  if (!baseURL) return undefined
  return baseURL.replace(/\/(v1beta|v1)\/?$/i, '').replace(/\/$/, '')
}

export function selectGeminiCacheCandidate(
  prompt: LanguageModelV3Message[],
  settings: GeminiCacheControlSettings,
  modelId: string
): GeminiCacheCandidate | undefined {
  if (!settings.enabled || !settings.tokenThreshold || prompt.length < MIN_STABLE_MESSAGES + 1) {
    return undefined
  }

  if (!settings.cacheSystemMessage && prompt.some((message) => message.role === 'system')) {
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
      cacheKey: buildStablePrefixKey(modelId, cacheablePrefixMessages, settings.cacheScope, settings.ttlSeconds),
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
  clientOptions: GeminiCacheClientOptions,
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

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      ...(normalizeCacheApiBaseUrl(clientOptions.baseURL)
        ? { baseUrl: normalizeCacheApiBaseUrl(clientOptions.baseURL) }
        : {}),
      apiVersion: 'v1beta',
      headers: clientOptions.headers
    }
  })
  const created = await ai.caches.create({
    model: modelId,
    config: {
      ttl: `${ttlSeconds}s`,
      contents,
      systemInstruction: buildGeminiSystemInstruction(prefixMessages)
    }
  })

  if (!created.name) throw new Error('Gemini cached-content creation returned no resource name')

  geminiCacheStore.set(cacheKey, {
    cachedContent: created.name,
    expiresAt: Date.now() + ttlSeconds * 1000
  })

  return created.name
}

function getHeaderValue(headers: LanguageModelV3CallOptions['headers'] | undefined, name: string): string | undefined {
  if (!headers) return undefined

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) || undefined
  }

  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return typeof entry?.[1] === 'string' && entry[1] ? entry[1] : undefined
}

function geminiCacheMiddleware(
  settings: GeminiCacheControlSettings,
  clientOptions: GeminiCacheClientOptions
): LanguageModelMiddleware {
  const originalParamsByCachedParams = new WeakMap<object, LanguageModelV3CallOptions>()
  const cacheKeyByCachedParams = new WeakMap<object, string>()

  const retryWithoutExpiredCache = async <T>(
    params: LanguageModelV3CallOptions,
    retry: (originalParams: LanguageModelV3CallOptions) => PromiseLike<T>,
    originalError: unknown
  ): Promise<T> => {
    const originalParams = originalParamsByCachedParams.get(params)
    const cacheKey = cacheKeyByCachedParams.get(params)
    if (!originalParams || !cacheKey) {
      throw originalError
    }

    geminiCacheStore.delete(cacheKey)
    geminiCacheFailureStore.set(cacheKey, Date.now() + CACHE_FAILURE_RETRY_COOLDOWN_MS)
    logger.warn('Gemini request using cached context failed; retrying once with the full prompt.')

    return await retry(originalParams)
  }

  return {
    specificationVersion: 'v3',
    transformParams: async ({ params, model }) => {
      if (!settings.enabled || !Array.isArray(params.prompt) || params.prompt.length === 0) {
        return params
      }

      // AI SDK v3 keeps the resolved model outside of LanguageModelV3CallOptions.
      // Reading params.model would make the cache appear to work in hand-written
      // tests while silently disabling it for real streamText/generateText calls.
      const modelId = typeof model?.modelId === 'string' ? model.modelId : ''
      if (!modelId) {
        return params
      }

      const cacheCandidate = selectGeminiCacheCandidate(params.prompt, settings, modelId)
      if (!cacheCandidate) {
        return params
      }

      // Gemini cached contents can include tool definitions and non-text parts,
      // but those need provider-specific conversion. Keep these requests whole
      // until the cache representation can be proven equivalent.
      if (params.tools?.length) {
        return params
      }

      const apiKey =
        clientOptions.apiKey ||
        getHeaderValue(params.headers, 'x-goog-api-key') ||
        getHeaderValue(params.headers, 'authorization')?.replace(/^Bearer\s+/i, '')
      if (!apiKey) {
        return params
      }

      // Google cache handles belong to the API key/project that created them.
      // Include a one-way key fingerprint so changing keys cannot accidentally
      // reuse a handle created under another credential.
      const cacheRequestKey = `${cacheCandidate.cacheKey}\nkey-${hashCacheScope(apiKey)}`
      const failureExpiresAt = geminiCacheFailureStore.get(cacheRequestKey)
      if (failureExpiresAt && failureExpiresAt > Date.now()) {
        return params
      }

      let cachedContent: string | undefined
      try {
        cachedContent = await resolveGeminiCachedContent(
          cacheRequestKey,
          apiKey,
          clientOptions,
          modelId,
          cacheCandidate.prefixMessages,
          settings.ttlSeconds
        )
        geminiCacheFailureStore.delete(cacheRequestKey)
      } catch (error) {
        // Prompt caching is an optimization. A cache-create failure (for
        // example when a gateway key cannot call Google's cache API) must not
        // fail the user's normal chat request. Avoid retrying the same broken
        // side request on every message for a short cooldown.
        geminiCacheFailureStore.set(cacheRequestKey, Date.now() + CACHE_FAILURE_RETRY_COOLDOWN_MS)
        logger.warn('Unable to create Gemini cached content; using the regular prompt.', {
          modelId,
          error: error instanceof Error ? error.message : String(error)
        })
        return params
      }

      if (!cachedContent) {
        return params
      }

      const googleOptions = (params.providerOptions?.google as Record<string, unknown> | undefined) || {}

      const cachedParams: LanguageModelV3CallOptions = {
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
      originalParamsByCachedParams.set(cachedParams, params)
      cacheKeyByCachedParams.set(cachedParams, cacheRequestKey)
      return cachedParams
    },
    wrapStream: async ({ doStream, params, model }) => {
      try {
        return await doStream()
      } catch (error) {
        return retryWithoutExpiredCache(params, (originalParams) => model.doStream(originalParams), error)
      }
    },
    wrapGenerate: async ({ doGenerate, params, model }) => {
      try {
        return await doGenerate()
      } catch (error) {
        return retryWithoutExpiredCache(params, (originalParams) => model.doGenerate(originalParams), error)
      }
    }
  }
}

export const createGeminiCachePlugin = (
  settings: GeminiCacheControlSettings,
  clientOptions: GeminiCacheClientOptions = {}
) =>
  definePlugin({
    name: 'geminiCache',
    enforce: 'pre',
    configureContext: (context) => {
      context.middlewares = context.middlewares || []
      context.middlewares.push(geminiCacheMiddleware(settings, clientOptions))
    }
  })
