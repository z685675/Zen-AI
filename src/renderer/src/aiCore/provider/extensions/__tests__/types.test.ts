import type { AppProviderId } from '@renderer/aiCore/types'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { extensions } from '../index'

describe('provider extension types', () => {
  it('exposes runtime ids and aliases', () => {
    const runtimeIds = extensions.flatMap((ext) => ext.getProviderIds())

    ;[
      'google-vertex',
      'vertexai',
      'google-vertex-anthropic',
      'vertexai-anthropic',
      'github-copilot-openai-compatible',
      'copilot',
      'bedrock',
      'aws-bedrock',
      'huggingface',
      'hf',
      'gateway',
      'ai-gateway',
      'ollama'
    ].forEach((id) => {
      expect(runtimeIds).toContain(id)
    })
  })

  it('ensures every extension exposes at least one provider id', () => {
    extensions.forEach((ext) => {
      expect(ext.getProviderIds().length).toBeGreaterThan(0)
    })
  })

  it('keeps compile-time ids in AppProviderId', () => {
    type Check1 = 'google-vertex' extends AppProviderId ? true : false
    type Check2 = 'vertexai' extends AppProviderId ? true : false
    type Check3 = 'ollama' extends AppProviderId ? true : false
    type Check4 = 'openai' extends AppProviderId ? true : false

    expectTypeOf<Check1>().toEqualTypeOf<true>()
    expectTypeOf<Check2>().toEqualTypeOf<true>()
    expectTypeOf<Check3>().toEqualTypeOf<true>()
    expectTypeOf<Check4>().toEqualTypeOf<true>()
  })
})
