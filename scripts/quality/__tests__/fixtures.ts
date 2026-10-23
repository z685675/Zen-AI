export const liveFixture = () => ({
  schemaVersion: 1,
  profile: 'quick',
  targets: [{ family: 'gpt', providerRef: 'test', modelId: 'chosen', entries: ['chat'] }],
  providers: [
    { providerRef: 'test', baseURL: 'http://127.0.0.1:1/v1', group: 'test', credentialEnv: 'ZEN_QUALITY_FIXTURE_KEY' }
  ],
  prices: [
    {
      providerRef: 'test',
      modelId: 'chosen',
      currency: 'CNY',
      basis: 'key-charge',
      source: 'unit fixture, not real quote',
      group: 'test',
      capturedAt: '2020-01-01T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z',
      tiers: [{ throughInputTokens: 200000, input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }]
    }
  ],
  execution: { maxInputTokensPerRequest: 200000, requestTimeoutMs: 1000, turnTimeoutMs: 1000, pauseMs: 0 },
  budget: {
    currency: 'CNY',
    maxAmount: 10,
    maxRequests: 20,
    maxOutputTokensPerRequest: 1000,
    maxInputTokens: 4000000,
    maxOutputTokens: 20000,
    timeoutMs: 60000
  }
})
