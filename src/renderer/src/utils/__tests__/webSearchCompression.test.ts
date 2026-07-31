import type { CompressionConfig } from '@renderer/store/websearch'
import { describe, expect, it } from 'vitest'

import { getEffectiveWebSearchCompression } from '../webSearchCompression'

describe('getEffectiveWebSearchCompression', () => {
  const ragConfig = {
    method: 'rag',
    embeddingModel: { id: 'text-embedding-3-small', provider: 'openai' }
  } as CompressionConfig

  it('disables legacy RAG compression for unified web search', () => {
    expect(getEffectiveWebSearchCompression(ragConfig)).toBeUndefined()
  })

  it('disables legacy cutoff compression for unified web search', () => {
    const cutoffConfig = {
      method: 'cutoff',
      cutoffLimit: 6000,
      cutoffUnit: 'char'
    } as CompressionConfig

    expect(getEffectiveWebSearchCompression(cutoffConfig)).toBeUndefined()
  })
})
