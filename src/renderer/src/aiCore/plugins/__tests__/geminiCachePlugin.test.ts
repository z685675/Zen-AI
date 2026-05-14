import type { LanguageModelV3CallOptions, LanguageModelV3Message } from '@ai-sdk/provider'
import type { GeminiCacheControlSettings } from '@renderer/types/provider'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createMock = vi.fn()

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    caches: {
      create: createMock
    }
  })),
  createModelContent: (parts: unknown[]) => ({ role: 'model', parts }),
  createUserContent: (parts: unknown[]) => ({ role: 'user', parts }),
  createPartFromText: (text: string) => ({ text })
}))

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

async function runMiddleware(params: LanguageModelV3CallOptions, settings = makeSettings()) {
  const plugin = createGeminiCachePlugin(settings)
  const context: {
    middlewares: Array<{ transformParams: (opts: Record<string, unknown>) => Promise<LanguageModelV3CallOptions> }>
  } = { middlewares: [] }
  void plugin.configureContext!(context as never)
  const middleware = context.middlewares[0]
  return middleware.transformParams({ params, type: 'generate', model: {} })
}

describe('geminiCachePlugin', () => {
  beforeEach(() => {
    createMock.mockReset()
    createMock.mockResolvedValue({ name: 'cachedContents/abc123' })
  })

  it('creates plugin with stable name', () => {
    const plugin = createGeminiCachePlugin(makeSettings())
    expect(plugin.name).toBe('geminiCache')
  })

  it('selects a stable prefix and keeps only the tail in the live request', async () => {
    const prompt = makePrompt()
    const result = await runMiddleware({
      model: 'gemini-2.5-pro',
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
      model: 'gemini-2.5-pro',
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

  it('skips cache when prompt is not text-only', async () => {
    const result = await runMiddleware({
      model: 'gemini-2.5-pro',
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'file', mediaType: 'image/png', data: 'x' }] }
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
        model: 'gemini-2.5-pro',
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

  it('accepts normal chat prefixes below the original threshold using a conservative relaxed floor', () => {
    const prompt = [
      { role: 'system', content: 'You are helping me polish an academic paragraph. '.repeat(24) },
      { role: 'user', content: 'Please keep the meaning unchanged and improve the wording. '.repeat(24) },
      { role: 'assistant', content: 'Understood. I will preserve the scientific meaning. '.repeat(24) },
      { role: 'user', content: 'Now rewrite this sentence more formally.' }
    ] satisfies LanguageModelV3Message[]

    const candidate = selectGeminiCacheCandidate(prompt, makeSettings({ tokenThreshold: 220 }), 'gemini-2.5-pro')

    expect(candidate).toBeDefined()
    expect(candidate?.tailMessages).toHaveLength(1)
  })
})
