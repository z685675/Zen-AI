import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Message } from '@ai-sdk/provider'
import type { GeminiCacheControlSettings } from '@renderer/types/provider'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createMock = vi.fn()
const googleGenAIMock = vi.fn()

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation((options) => {
    googleGenAIMock(options)
    return {
      caches: {
        create: createMock
      }
    }
  }),
  createModelContent: (parts: unknown[]) => ({ role: 'model', parts }),
  createUserContent: (parts: unknown[]) => ({ role: 'user', parts }),
  createPartFromText: (text: string) => ({ text })
}))

import { GoogleGenAI } from '@google/genai'

import { createGeminiCachePlugin, selectGeminiCacheCandidate } from '../geminiCachePlugin'

function makeSettings(overrides: Partial<GeminiCacheControlSettings> = {}): GeminiCacheControlSettings {
  return {
    enabled: true,
    tokenThreshold: 10,
    cacheSystemMessage: true,
    cacheEarlyMessages: 2,
    ttlSeconds: 3600,
    ...overrides
  }
}

function makePrompt(): LanguageModelV3Message[] {
  return [
    { role: 'system', content: 'You are a research assistant for academic writing.' },
    { role: 'user', content: 'We are discussing a paper on catalyst stability and degradation pathways.' },
    { role: 'assistant', content: 'I will keep the style formal and focus on scientific accuracy.' },
    { role: 'user', content: 'Please summarize the discussion section in clearer English.' }
  ]
}

async function runMiddleware(
  params: LanguageModelV3CallOptions,
  settings = makeSettings(),
  clientOptions: { apiKey?: string; baseURL?: string; headers?: Record<string, string> } = {}
) {
  const plugin = createGeminiCachePlugin(settings, clientOptions)
  const context: {
    middlewares: Array<{ transformParams: (opts: Record<string, unknown>) => Promise<LanguageModelV3CallOptions> }>
  } = { middlewares: [] }
  void plugin.configureContext!(context as never)
  const middleware = context.middlewares[0]
  return middleware.transformParams({
    params,
    type: 'generate',
    model: { modelId: 'gemini-2.5-pro' } as LanguageModelV3
  })
}

describe('geminiCachePlugin', () => {
  beforeEach(() => {
    createMock.mockReset()
    googleGenAIMock.mockReset()
    vi.mocked(GoogleGenAI).mockClear()
    createMock.mockResolvedValue({ name: 'cachedContents/abc123' })
  })

  it('creates plugin with stable name', () => {
    const plugin = createGeminiCachePlugin(makeSettings())
    expect(plugin.name).toBe('geminiCache')
  })

  it('selects a stable prefix and keeps only the tail in the live request', async () => {
    const prompt = makePrompt()
    const result = await runMiddleware({
      prompt,
      headers: {
        'x-goog-api-key': 'test-key'
      },
      providerOptions: {
        google: {
          temperature: 0.2
        }
      }
    } as unknown as LanguageModelV3CallOptions)

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(result.prompt).toEqual(prompt.slice(3))
    expect(result.providerOptions?.google).toMatchObject({
      temperature: 0.2,
      cachedContent: 'cachedContents/abc123'
    })
  })

  it('reuses created cache for the same prefix without creating a second remote cache', async () => {
    const prompt = makePrompt()
    const firstParams = {
      prompt,
      headers: {
        'x-goog-api-key': 'test-key'
      },
      providerOptions: {
        google: {}
      }
    } as unknown as LanguageModelV3CallOptions

    const secondParams = {
      ...firstParams,
      prompt: [...prompt, { role: 'assistant', content: 'Here is a first polished rewrite of that paragraph.' }]
    } as unknown as LanguageModelV3CallOptions

    const first = await runMiddleware(firstParams)
    const second = await runMiddleware(secondParams)

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(first.providerOptions?.google).toMatchObject({ cachedContent: 'cachedContents/abc123' })
    expect(second.providerOptions?.google).toMatchObject({ cachedContent: 'cachedContents/abc123' })
  })

  it('creates explicit caches through the configured gateway URL with the configured credentials', async () => {
    const prompt = makePrompt()
    const result = await runMiddleware(
      {
        prompt,
        providerOptions: { google: {} }
      } as unknown as LanguageModelV3CallOptions,
      makeSettings({ cacheScope: 'gateway-settings-test' }),
      {
        apiKey: 'gateway-test-key',
        baseURL: 'https://api.example.test/v1beta/',
        headers: { 'X-Zen-Test': 'enabled' }
      }
    )

    expect(result.providerOptions?.google).toMatchObject({ cachedContent: 'cachedContents/abc123' })
    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'gateway-test-key',
      httpOptions: {
        baseUrl: 'https://api.example.test',
        apiVersion: 'v1beta',
        headers: { 'X-Zen-Test': 'enabled' }
      }
    })
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-pro',
        config: expect.objectContaining({
          systemInstruction: expect.anything(),
          ttl: '3600s'
        })
      })
    )
  })

  it('skips cache when prompt is not text-only', async () => {
    const result = await runMiddleware({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'file', mediaType: 'image/png', data: 'x' }
          ]
        }
      ],
      headers: {
        'x-goog-api-key': 'test-key'
      }
    } as unknown as LanguageModelV3CallOptions)

    expect(createMock).not.toHaveBeenCalled()
    expect(result.prompt).toHaveLength(1)
  })

  it('skips cache when stable prefix tokens do not reach threshold', async () => {
    const prompt = [
      { role: 'system', content: 'Short system' },
      { role: 'user', content: 'Short user' },
      { role: 'assistant', content: 'Short assistant' }
    ] satisfies LanguageModelV3Message[]

    const result = await runMiddleware(
      {
        prompt,
        headers: {
          'x-goog-api-key': 'test-key'
        }
      } as unknown as LanguageModelV3CallOptions,
      makeSettings({ tokenThreshold: 5000 })
    )

    expect(createMock).not.toHaveBeenCalled()
    expect(result.prompt).toEqual(prompt)
  })

  it('builds a cache candidate with a bounded tail for same-topic conversations', () => {
    const candidate = selectGeminiCacheCandidate(makePrompt(), makeSettings(), 'gemini-2.5-pro')

    expect(candidate).toBeDefined()
    expect(candidate?.prefixMessages).toHaveLength(3)
    expect(candidate?.tailMessages).toHaveLength(1)
    expect(candidate?.cacheKey).toContain('zen-gemini-cache')
  })

  it('does not attempt cache creation below the configured minimum token threshold', () => {
    const candidate = selectGeminiCacheCandidate(makePrompt(), makeSettings({ tokenThreshold: 5000 }), 'gemini-2.5-pro')

    expect(candidate).toBeUndefined()
  })

  it('keeps the chat request working when remote cache creation fails', async () => {
    createMock.mockRejectedValueOnce(new Error('gateway key cannot create Google cached content'))
    const prompt = makePrompt()
    const params = {
      prompt,
      headers: {
        'X-Goog-Api-Key': 'test-key'
      }
    } as unknown as LanguageModelV3CallOptions

    await expect(runMiddleware(params, makeSettings({ cacheScope: 'failure-test-service' }))).resolves.toEqual(params)
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('retries once with the original prompt when the cached-content route fails', async () => {
    const settings = makeSettings({ cacheScope: 'expired-handle-fallback-test' })
    const plugin = createGeminiCachePlugin(settings)
    const context: { middlewares: unknown[] } = { middlewares: [] }
    void plugin.configureContext!(context as never)
    const middleware = context.middlewares[0] as {
      transformParams: (options: Record<string, unknown>) => Promise<LanguageModelV3CallOptions>
      wrapStream: (options: Record<string, unknown>) => Promise<unknown>
    }
    const originalParams = {
      prompt: makePrompt(),
      headers: { 'x-goog-api-key': 'fallback-test-key' },
      providerOptions: { google: { temperature: 0.1 } }
    } as unknown as LanguageModelV3CallOptions
    const model = {
      modelId: 'gemini-2.5-pro',
      doStream: vi.fn().mockResolvedValue({ stream: 'retried-with-full-prompt' })
    }
    const cachedParams = await middleware.transformParams({ params: originalParams, model, type: 'stream' })
    const cachedRouteError = Object.assign(new Error('Upstream channel unavailable'), { statusCode: 503 })
    const doStream = vi.fn().mockRejectedValue(cachedRouteError)

    const result = await middleware.wrapStream({ doStream, params: cachedParams, model })

    expect(result).toEqual({ stream: 'retried-with-full-prompt' })
    expect(model.doStream).toHaveBeenCalledWith(originalParams)
    expect(doStream).toHaveBeenCalledTimes(1)
  })
})
