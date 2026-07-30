import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  formatProviderApiHost: vi.fn(async (provider) => provider)
}))

vi.mock('@main/services/ReduxService', () => ({
  reduxService: { select: mocks.select }
}))

vi.mock('@main/aiCore/provider/providerConfig', () => ({
  formatProviderApiHost: mocks.formatProviderApiHost
}))

vi.mock('@main/services/LoggerService', () => ({
  loggerService: {
    withContext: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
  }
}))

import { getAvailableProviders } from '..'

describe('getAvailableProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps native Gemini and OpenAI-type Grok providers visible to the Agent API', async () => {
    mocks.select.mockResolvedValue([
      {
        id: 'gemini',
        type: 'gemini',
        name: 'Gemini',
        apiKey: 'key',
        apiHost: 'https://generativelanguage.googleapis.com',
        enabled: true,
        models: []
      },
      {
        id: 'grok',
        type: 'openai',
        name: 'Grok',
        apiKey: 'key',
        apiHost: 'https://api.x.ai',
        enabled: true,
        models: []
      },
      {
        id: 'disabled-gemini',
        type: 'gemini',
        name: 'Disabled',
        apiKey: 'key',
        apiHost: 'https://example.com',
        enabled: false,
        models: []
      },
      {
        id: 'vertex',
        type: 'vertexai',
        name: 'Vertex',
        apiKey: 'key',
        apiHost: 'https://example.com',
        enabled: true,
        models: []
      }
    ])

    const providers = await getAvailableProviders()

    expect(providers.map((provider) => provider.id)).toEqual(['gemini', 'grok'])
    expect(mocks.formatProviderApiHost).toHaveBeenCalledTimes(2)
  })
})
