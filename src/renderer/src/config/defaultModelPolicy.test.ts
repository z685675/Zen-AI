import type { Model, Provider } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import {
  CURRENT_DEFAULT_MODEL_POLICY_VERSION,
  getCurrentDefaultModels,
  getPendingCurrentDefaultModels
} from './defaultModelPolicy'

const model: Model = {
  id: 'gpt-5.6-luna',
  provider: 'new-api',
  name: 'GPT 5.6 Luna',
  group: 'OpenAI'
}

const provider: Provider = {
  id: 'new-api',
  name: 'New API',
  type: 'openai',
  apiKey: 'test-key',
  apiHost: 'https://example.com/v1',
  models: [model],
  enabled: true
}

describe('retired bundled default model policy', () => {
  it('does not embed a default model in the desktop client', () => {
    expect(CURRENT_DEFAULT_MODEL_POLICY_VERSION).toBe(0)
    expect(getCurrentDefaultModels([model])).toEqual({})
  })

  it('never applies a bundled model after Provider import', () => {
    expect(getPendingCurrentDefaultModels([provider])).toBeUndefined()
  })
})
