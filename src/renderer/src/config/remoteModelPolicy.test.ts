import type { Model, Provider } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { resolveRemoteDefaultModel } from './remoteModelPolicy'

const createProvider = (id: string, apiHost: string, modelIds: string[], enabled = true): Provider => ({
  id,
  type: 'new-api',
  name: id,
  apiKey: 'test-key',
  apiHost,
  enabled,
  models: modelIds.map((modelId): Model => ({ id: modelId, provider: id, name: modelId, group: 'default' }))
})

describe('remote default model resolution', () => {
  const localProvider = createProvider('local', 'http://127.0.0.1:3000', ['gpt-5.6-luna'])
  const officialProvider = createProvider('zen-official', 'https://zenai.925636.xyz', ['gpt-5.6-luna'])

  it('keeps the current Provider when it exposes the configured model', () => {
    const current = localProvider.models[0]

    expect(resolveRemoteDefaultModel([officialProvider, localProvider], 'gpt-5.6-luna', current)?.provider).toBe(
      'local'
    )
  })

  it('prefers the Zen AI managed Provider when there is no current Provider match', () => {
    expect(resolveRemoteDefaultModel([localProvider, officialProvider], 'gpt-5.6-luna')?.provider).toBe('zen-official')
  })

  it('falls back to another enabled Provider when the managed Provider is unavailable', () => {
    const disabledOfficial = { ...officialProvider, enabled: false }

    expect(resolveRemoteDefaultModel([disabledOfficial, localProvider], 'gpt-5.6-luna')?.provider).toBe('local')
  })

  it('returns undefined when no enabled Provider exposes the configured model', () => {
    expect(resolveRemoteDefaultModel([localProvider], 'grok-4.5')).toBeUndefined()
  })
})
