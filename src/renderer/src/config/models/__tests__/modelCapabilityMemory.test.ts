import type { Model } from '@renderer/types'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearLearnedModelCapabilityFailure,
  hasLearnedModelCapabilityFailure,
  isLikelyUnsupportedModelCapabilityError,
  rememberModelCapabilityFailure
} from '../modelCapabilityMemory'

const createModel = (overrides: Partial<Model> = {}): Model => ({
  id: 'custom-chat-model',
  name: 'custom-chat-model',
  provider: 'test-provider',
  group: 'Test',
  ...overrides
})

describe('model capability memory', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('scopes learned failures by provider, model and capability', () => {
    const model = createModel()
    const sameModelOnAnotherProvider = createModel({ provider: 'another-provider' })
    const anotherCapability = createModel({ id: 'another-model' })

    rememberModelCapabilityFailure(model, 'function_calling')

    expect(hasLearnedModelCapabilityFailure(model, 'function_calling')).toBe(true)
    expect(hasLearnedModelCapabilityFailure(model, 'vision')).toBe(false)
    expect(hasLearnedModelCapabilityFailure(sameModelOnAnotherProvider, 'function_calling')).toBe(false)
    expect(hasLearnedModelCapabilityFailure(anotherCapability, 'function_calling')).toBe(false)
  })

  it('allows a capability to be cleared after the route changes', () => {
    const model = createModel()
    rememberModelCapabilityFailure(model, 'vision')

    clearLearnedModelCapabilityFailure(model, 'vision')

    expect(hasLearnedModelCapabilityFailure(model, 'vision')).toBe(false)
  })

  it('recognizes unsupported capability errors but ignores connectivity failures', () => {
    expect(
      isLikelyUnsupportedModelCapabilityError(
        { statusCode: 400, message: 'The request parameter tools is not supported by this model' },
        'function_calling'
      )
    ).toBe(true)
    expect(
      isLikelyUnsupportedModelCapabilityError(
        { statusCode: 400, message: 'This model does not support image input' },
        'vision'
      )
    ).toBe(true)
    expect(isLikelyUnsupportedModelCapabilityError({ message: 'Failed to fetch' }, 'function_calling')).toBe(false)
    expect(
      isLikelyUnsupportedModelCapabilityError(
        { statusCode: 500, message: 'tools are not supported' },
        'function_calling'
      )
    ).toBe(false)
  })
})
