import { OpenAICompatibleChatLanguageModel } from '@ai-sdk/openai-compatible'
import { describe, expect, it, vi } from 'vitest'

import { attachPromptCacheKeyToProviderOptions, buildPromptCacheKey } from '../../promptCache'

describe('prompt cache request options', () => {
  it('uses the OpenAI SDK camelCase option for native OpenAI requests', () => {
    const result = attachPromptCacheKeyToProviderOptions({ openai: { serviceTier: 'auto' } }, 'topic-1', {
      runtimeProviderId: 'openai',
      actualProviderId: 'openai',
      modelId: 'gpt-5.6-sol'
    })

    expect(result).toMatchObject({
      scope: 'openai',
      field: 'promptCacheKey',
      providerOptions: {
        openai: {
          serviceTier: 'auto'
        }
      }
    })
    expect(result?.promptCacheKey).toMatch(/^topic-1:openai:gpt-5\.6-sol:svc-[0-9a-f]{8}$/)
    expect(result?.providerOptions.openai?.promptCacheKey).toBe(result?.promptCacheKey)
  })

  it('uses the snake_case field for OpenAI-compatible requests', () => {
    const result = attachPromptCacheKeyToProviderOptions({ newapi: { reasoningEffort: 'high' } }, 'topic-1', {
      runtimeProviderId: 'newapi',
      actualProviderId: 'newapi',
      modelId: 'gpt-5.6-sol',
      modelEndpointType: 'openai'
    })

    expect(result?.field).toBe('prompt_cache_key')
    expect(result?.providerOptions.newapi).toMatchObject({
      reasoningEffort: 'high'
    })
    expect(result?.providerOptions.newapi?.prompt_cache_key).toBe(result?.promptCacheKey)
    expect(result?.promptCacheKey).toMatch(/^topic-1:newapi:gpt-5\.6-sol:svc-[0-9a-f]{8}$/)
    expect(result?.providerOptions.newapi).not.toHaveProperty('promptCacheKey')
  })

  it('serializes the compatible option as prompt_cache_key in the HTTP body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    const model = new OpenAICompatibleChatLanguageModel('gpt-5.6-sol', {
      provider: 'newapi.chat',
      url: ({ path }) => `https://example.test${path}`,
      headers: () => ({}),
      fetch: fetchMock
    })

    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      providerOptions: {
        newapi: { prompt_cache_key: 'topic-1:newapi:gpt-5.6-sol' }
      }
    })

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(requestBody.prompt_cache_key).toBe('topic-1:newapi:gpt-5.6-sol')
    expect(requestBody).not.toHaveProperty('promptCacheKey')
  })

  it('maps NewAPI Responses requests to the native OpenAI option scope', () => {
    const result = attachPromptCacheKeyToProviderOptions({ newapi: {} }, 'topic-1', {
      runtimeProviderId: 'newapi',
      actualProviderId: 'newapi',
      modelId: 'gpt-5.6-sol',
      modelEndpointType: 'openai-response'
    })

    expect(result?.providerOptions.openai?.promptCacheKey).toBe(result?.promptCacheKey)
  })

  it('does not create a cache key without a topic', () => {
    expect(
      attachPromptCacheKeyToProviderOptions({}, undefined, {
        runtimeProviderId: 'newapi',
        actualProviderId: 'newapi',
        modelId: 'gpt-5.6-sol'
      })
    ).toBeUndefined()
    expect(buildPromptCacheKey('topic-1', 'newapi', 'gpt-5.6-sol')).toBe('topic-1:newapi:gpt-5.6-sol')
  })

  it('isolates the same topic/model when the API service changes', () => {
    const first = attachPromptCacheKeyToProviderOptions({}, 'topic-1', {
      runtimeProviderId: 'newapi',
      actualProviderId: 'newapi',
      modelId: 'gpt-5.6-sol',
      apiHost: 'https://api.first.example/v1/'
    })
    const second = attachPromptCacheKeyToProviderOptions({}, 'topic-1', {
      runtimeProviderId: 'newapi',
      actualProviderId: 'newapi',
      modelId: 'gpt-5.6-sol',
      apiHost: 'https://api.second.example/v1/'
    })

    expect(first?.promptCacheKey).not.toBe(second?.promptCacheKey)
  })
})
