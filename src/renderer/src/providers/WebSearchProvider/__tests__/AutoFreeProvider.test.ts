import type { WebSearchState } from '@renderer/store/websearch'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AutoFreeProvider, { extractWeatherLocation, runSearchStage } from '../AutoFreeProvider'

const webSearchState = {
  maxResults: 5
} as WebSearchState

describe('AutoFreeProvider', () => {
  afterEach(() => {
    vi.useRealTimers()
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

  it('uses Open-Meteo for weather queries without an API key', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                name: '南京',
                latitude: 32.06,
                longitude: 118.79,
                timezone: 'Asia/Shanghai',
                country: '中国',
                admin1: '江苏'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            timezone: 'Asia/Shanghai',
            current: {
              time: '2026-08-01T01:00',
              temperature_2m: 29,
              apparent_temperature: 33,
              precipitation: 0,
              wind_speed_10m: 8
            },
            daily: {
              time: ['2026-08-01'],
              temperature_2m_max: [35],
              temperature_2m_min: [27],
              precipitation_probability_max: [60]
            },
            hourly: {
              time: ['2026-08-01T01:00', '2026-08-01T02:00', '2026-08-01T03:00', '2026-08-01T04:00'],
              temperature_2m: [29, 29, 28, 28],
              precipitation_probability: [10, 20, 50, 60],
              precipitation: [0, 0, 0.2, 0.8]
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )

    const provider = new AutoFreeProvider({ id: 'auto-free', name: 'Auto Search' })
    const result = await provider.search('请查询南京未来24小时天气', webSearchState)

    expect(result.results[0].url).toContain('api.open-meteo.com')
    expect(result.results[0].content).toContain('Forecast time zone: Asia/Shanghai')
    expect(result.results[0].content).toContain('2026-08-01T03:00')
  })

  it('extracts a city from the full rewritten weather request used by AI chat', () => {
    expect(
      extractWeatherLocation(
        '请查询南京未来24小时天气，重点告诉我降雨时间、最低和最高气温。优先使用权威气象来源，明确日期、小时降雨时段、最低/最高气温及降水概率。'
      )
    ).toBe('南京')
  })

  it('uses the realtime Sina Finance feed for recent finance-news requests', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            timestamp: 'Sat Aug 01 01:16:11 +0800 2026',
            data: [
              {
                title: '测试财经新闻',
                ctime: String(nowSeconds - 600),
                media_name: '测试财经媒体',
                url: 'https://finance.sina.com.cn/example.shtml',
                intro: '用于验证实时财经新闻链路。'
              }
            ]
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    const provider = new AutoFreeProvider({ id: 'auto-free', name: 'Auto Search' })
    const result = await provider.search(
      '请总结最近6小时内最值得关注的5条中国财经新闻，并说明每条新闻的发布时间和来源。',
      webSearchState
    )

    expect(result.results[0].title).toBe('测试财经新闻')
    expect(result.results[0].content).toContain('within the requested 6-hour window')
    expect(result.results[0].content).toContain('测试财经媒体')
  })

  it('uses a keyless structured source for the current Weibo hot list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 200,
          message: '获取成功',
          data: [
            { title: '测试热搜一', hot_value: 900000, link: 'https://s.weibo.com/weibo?q=1' },
            { title: '测试热搜二', hot_value: 800000, link: 'https://s.weibo.com/weibo?q=2' }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    const provider = new AutoFreeProvider({ id: 'auto-free', name: 'Auto Search' })
    const result = await provider.search('请查询今日微博热搜前10', webSearchState)

    expect(result.results).toHaveLength(2)
    expect(result.results[0].title).toBe('测试热搜一')
    expect(result.results[0].content).toContain('Rank: 1')
    expect(result.results[0].content).toContain('Asia/Shanghai')
  })

  it('parses Bing News RSS for non-finance current-news requests', async () => {
    const publishedAt = new Date(Date.now() - 30 * 60 * 1000).toUTCString()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        `<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0"><channel><item>
          <title>AI 行业测试新闻</title>
          <link>https://example.com/ai-news</link>
          <pubDate>${publishedAt}</pubDate>
          <description><![CDATA[<p>一条带摘要的测试新闻。</p>]]></description>
        </item></channel></rss>`,
        { status: 200, headers: { 'content-type': 'application/xml' } }
      )
    )

    const provider = new AutoFreeProvider({ id: 'auto-free', name: 'Auto Search' })
    const result = await provider.search('请总结今天的 AI 行业新闻', webSearchState)

    expect(result.results[0].title).toBe('AI 行业测试新闻')
    expect(result.results[0].content).toContain('一条带摘要的测试新闻')
    expect(result.results[0].content).toContain('within the requested 24-hour window')
  })

  it('uses the official Node.js release index for latest LTS queries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { version: 'v26.0.0', date: '2026-07-28', lts: false },
          { version: 'v24.6.0', date: '2026-07-15', lts: 'Krypton' }
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    const provider = new AutoFreeProvider({ id: 'auto-free', name: 'Auto Search' })
    const result = await provider.search('请查询 Node.js 最新 LTS 版本', webSearchState)

    expect(result.results[0].url).toBe('https://nodejs.org/dist/index.json')
    expect(result.results[0].content).toContain('Latest LTS: v24.6.0')
    expect(result.results[0].content).toContain('LTS codename: Krypton')
  })

  it('aborts a free-search stage that exceeds its budget', async () => {
    vi.useFakeTimers()
    const operation = vi.fn(
      (options: RequestInit) =>
        new Promise<string>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true
          })
        })
    )

    const resultPromise = runSearchStage('Slow source', 5000, undefined, operation)
    const rejection = expect(resultPromise).rejects.toThrow('Slow source timed out after 5000ms')

    await vi.advanceTimersByTimeAsync(5000)

    await rejection
    expect(operation).toHaveBeenCalledOnce()
  })
})
