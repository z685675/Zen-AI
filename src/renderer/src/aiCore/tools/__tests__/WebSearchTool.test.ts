import type { ExtractResults } from '@renderer/utils/extract'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getWebSearchProvider: vi.fn(),
  processWebsearch: vi.fn()
}))

vi.mock('@renderer/services/WebSearchService', () => ({
  default: {
    getWebSearchProvider: mocks.getWebSearchProvider,
    processWebsearch: mocks.processWebsearch
  }
}))

import { webSearchToolWithPreExtractedKeywords } from '../WebSearchTool'

describe('webSearchToolWithPreExtractedKeywords', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getWebSearchProvider.mockReturnValue({ id: 'auto-free', name: 'Auto Search' })
    mocks.processWebsearch.mockResolvedValue({ query: 'finance', results: [] })
  })

  it('always preserves the prepared user query', async () => {
    const originalQuery = '请总结最近6小时内最值得关注的5条中国财经新闻，并说明发布时间和来源。'
    const webSearchTool = webSearchToolWithPreExtractedKeywords('auto-free', { question: [originalQuery] }, 'request-1')

    await webSearchTool.execute(
      {},
      {
        abortSignal: undefined,
        messages: [],
        toolCallId: 'tool-call-1'
      }
    )

    const extractResults = mocks.processWebsearch.mock.calls[0][1] as ExtractResults
    expect(extractResults.websearch?.question).toEqual([originalQuery])
    expect(mocks.processWebsearch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'auto-free' }),
      expect.any(Object),
      'request-1'
    )
  })
})
