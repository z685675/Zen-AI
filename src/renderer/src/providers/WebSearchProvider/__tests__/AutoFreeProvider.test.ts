import type { WebSearchState } from '@renderer/store/websearch'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AutoFreeProvider from '../AutoFreeProvider'

const webSearchState = {
  maxResults: 5
} as WebSearchState

describe('AutoFreeProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the keyless structured exchange-rate source before general web search', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          date: '2026-07-30',
          base: 'USD',
          quote: 'CNY',
          rate: 6.7603
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    const provider = new AutoFreeProvider({
      id: 'auto-free',
      name: 'Auto Search'
    })
    const result = await provider.search('100 美元兑人民币汇率', webSearchState)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].url).toBe('https://api.frankfurter.dev/v2/rate/USD/CNY')
    expect(result.results[0].content).toContain('100 USD = 676.03 CNY')
  })

  it('uses the local clock for current-time questions without a network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const provider = new AutoFreeProvider({
      id: 'auto-free',
      name: 'Auto Search'
    })
    const result = await provider.search('现在北京时间是几点', webSearchState)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.results[0].url).toBe('https://www.iana.org/time-zones')
    expect(result.results[0].content).toContain('Asia/Shanghai')
  })
})
