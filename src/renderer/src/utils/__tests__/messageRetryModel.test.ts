import type { Model } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { resolveRetryModelSelection } from '../messageRetryModel'

const gptModel = {
  id: 'gpt-5.6-luna',
  name: 'gpt-5.6-luna',
  provider: 'zen'
} as Model

const grokModel = {
  id: 'grok-4.5',
  name: 'grok-4.5',
  provider: 'zen'
} as Model

describe('resolveRetryModelSelection', () => {
  it('uses the current conversation model for a normal regenerated response', () => {
    expect(
      resolveRetryModelSelection({
        conversationModel: gptModel,
        originalAssistantMessage: {
          model: grokModel
        },
        preserveOriginalModel: false
      })
    ).toEqual({
      model: gptModel,
      modelId: undefined
    })
  })

  it('clears stale modelId metadata after restoring a normal conversation', () => {
    expect(
      resolveRetryModelSelection({
        conversationModel: gptModel,
        originalAssistantMessage: {
          model: grokModel,
          modelId: grokModel.id
        },
        preserveOriginalModel: false
      })
    ).toEqual({
      model: gptModel,
      modelId: undefined
    })
  })

  it('preserves the original model for an explicit multi-model response', () => {
    expect(
      resolveRetryModelSelection({
        conversationModel: gptModel,
        originalAssistantMessage: {
          model: grokModel,
          modelId: grokModel.id
        },
        preserveOriginalModel: true
      })
    ).toEqual({
      model: grokModel,
      modelId: grokModel.id
    })
  })
})
