import { loggerService } from '@logger'
import type { WebSearchState } from '@renderer/store/websearch'
import type { WebSearchProviderResponse } from '@renderer/types'
import { isAbortError } from '@renderer/utils/error'
import { XMLParser } from 'fast-xml-parser'

import BaseWebSearchProvider from './BaseWebSearchProvider'
import ExaMcpProvider from './ExaMcpProvider'

const logger = loggerService.withContext('AutoFreeProvider')
const STRUCTURED_SEARCH_TIMEOUT_MS = 20000
const EXA_SEARCH_TIMEOUT_MS = 9000
const BROWSER_SEARCH_TIMEOUT_MS = 18000

export async function runSearchStage<T>(
  label: string,
  timeoutMs: number,
  httpOptions: RequestInit | undefined,
  operation: (options: RequestInit) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  const parentSignal = httpOptions?.signal
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal

  try {
    return await operation({ ...httpOptions, signal })
  } catch (error) {
    if (parentSignal?.aborted) {
      throw new DOMException('Operation aborted', 'AbortError')
    }
    if (controller.signal.aborted && !parentSignal?.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

const CURRENCY_ALIASES: Array<{ code: string; aliases: string[] }> = [
  { code: 'CNY', aliases: ['人民币', '人民币元', '元人民币', 'CNY', 'RMB'] },
  { code: 'USD', aliases: ['美元', '美金', 'USD'] },
  { code: 'EUR', aliases: ['欧元', 'EUR'] },
  { code: 'GBP', aliases: ['英镑', 'GBP'] },
  { code: 'JPY', aliases: ['日元', '日币', 'JPY'] },
  { code: 'HKD', aliases: ['港币', '港元', 'HKD'] },
  { code: 'KRW', aliases: ['韩元', 'KRW'] },
  { code: 'AUD', aliases: ['澳元', '澳币', 'AUD'] },
  { code: 'CAD', aliases: ['加元', '加拿大元', 'CAD'] },
  { code: 'SGD', aliases: ['新加坡元', '新币', 'SGD'] }
]

type FrankfurterRate = {
  date?: string
  base?: string
  quote?: string
  rate?: number
}

type OpenMeteoLocation = {
  name: string
  latitude: number
  longitude: number
  timezone?: string
  country?: string
  admin1?: string
}

type OpenMeteoGeocodingResponse = {
  results?: OpenMeteoLocation[]
}

type OpenMeteoForecastResponse = {
  timezone?: string
  current?: {
    time?: string
    temperature_2m?: number
    apparent_temperature?: number
    precipitation?: number
    rain?: number
    weather_code?: number
    wind_speed_10m?: number
  }
  daily?: {
    time?: string[]
    temperature_2m_max?: number[]
    temperature_2m_min?: number[]
    precipitation_probability_max?: number[]
  }
  hourly?: {
    time?: string[]
    temperature_2m?: number[]
    precipitation_probability?: number[]
    precipitation?: number[]
  }
}

type NodeRelease = {
  version: string
  date: string
  lts: string | false
}

type SinaFinanceItem = {
  ctime?: string
  intro?: string
  media_name?: string
  title?: string
  url?: string
}

type SinaFinanceResponse = {
  result?: {
    data?: SinaFinanceItem[]
    timestamp?: string
  }
}

type BingNewsItem = {
  description?: string
  link?: string
  pubDate?: string
  title?: string
}

type WeiboHotResponse = {
  code?: number
  data?: Array<{
    hot_value?: number
    link?: string
    title?: string
  }>
  message?: string
}

type StructuredResourceResponse = {
  body: string
  contentType: string
  finalUrl: string
  ok: boolean
  status: number
}

async function waitForStructuredResource(
  promise: Promise<StructuredResourceResponse>,
  signal?: AbortSignal
): Promise<StructuredResourceResponse> {
  if (!signal) return promise
  if (signal.aborted) throw new DOMException('Operation aborted', 'AbortError')

  return await new Promise<StructuredResourceResponse>((resolve, reject) => {
    const handleAbort = () => reject(new DOMException('Operation aborted', 'AbortError'))
    signal.addEventListener('abort', handleAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', handleAbort))
  })
}

async function fetchStructuredText(url: string, signal?: AbortSignal): Promise<string> {
  const mainProcessFetch = typeof window !== 'undefined' ? window.api?.searchService?.fetchResource : undefined

  if (typeof mainProcessFetch === 'function') {
    const response = await waitForStructuredResource(mainProcessFetch(url), signal)
    if (!response.ok) {
      throw new Error(`Structured source request failed (${response.status})`)
    }
    return response.body
  }

  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`Structured source request failed (${response.status})`)
  }
  return await response.text()
}

async function fetchStructuredJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return JSON.parse(await fetchStructuredText(url, signal)) as T
}

const TIMEZONE_ALIASES: Array<{ timezone: string; aliases: string[] }> = [
  { timezone: 'Asia/Shanghai', aliases: ['北京时间', '北京', '上海', '中国', 'China', 'Beijing', 'Shanghai'] },
  { timezone: 'Asia/Tokyo', aliases: ['东京', '日本', 'Tokyo', 'Japan'] },
  { timezone: 'Asia/Seoul', aliases: ['首尔', '韩国', 'Seoul', 'Korea'] },
  { timezone: 'Europe/London', aliases: ['伦敦', '英国', 'London', 'UK'] },
  { timezone: 'Europe/Paris', aliases: ['巴黎', '法国', 'Paris', 'France'] },
  { timezone: 'Europe/Berlin', aliases: ['柏林', '德国', 'Berlin', 'Germany'] },
  { timezone: 'America/New_York', aliases: ['纽约', 'New York'] },
  { timezone: 'America/Los_Angeles', aliases: ['洛杉矶', '旧金山', 'Los Angeles', 'San Francisco'] },
  { timezone: 'Australia/Sydney', aliases: ['悉尼', 'Sydney'] },
  { timezone: 'UTC', aliases: ['UTC', 'GMT'] }
]

function searchCurrentTime(query: string): WebSearchProviderResponse | undefined {
  if (!/(?:现在几点|当前时间|现在.*时间)|\b(?:current\s+time|what\s+time|time\s+in)\b/i.test(query)) {
    return undefined
  }

  const timezone =
    TIMEZONE_ALIASES.find(({ aliases }) => aliases.some((alias) => query.toLowerCase().includes(alias.toLowerCase())))
      ?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
  const formattedTime = new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'long'
  }).format(new Date())

  return {
    query,
    results: [
      {
        title: `Current time in ${timezone}`,
        url: 'https://www.iana.org/time-zones',
        content: `Current system time: ${formattedTime}\nIANA time zone: ${timezone}\nGenerated from the local system clock using the IANA time-zone database.`
      }
    ]
  }
}

function extractCurrencyPair(query: string): [string, string] | undefined {
  const matches = CURRENCY_ALIASES.flatMap(({ code, aliases }) =>
    aliases.flatMap((alias) => {
      const index = query.toUpperCase().indexOf(alias.toUpperCase())
      return index >= 0 ? [{ code, index }] : []
    })
  )
    .sort((a, b) => a.index - b.index)
    .filter((item, index, items) => items.findIndex((candidate) => candidate.code === item.code) === index)

  return matches.length >= 2 ? [matches[0].code, matches[1].code] : undefined
}

function extractAmount(query: string): number {
  const match = query.match(
    /(?:^|[^\d])(\d+(?:\.\d+)?)\s*(?:人民币|人民币元|元人民币|美元|美金|欧元|英镑|日元|日币|港币|港元|韩元|澳元|澳币|加元|加拿大元|新加坡元|新币|CNY|RMB|USD|EUR|GBP|JPY|HKD|KRW|AUD|CAD|SGD)/i
  )
  const amount = match ? Number(match[1]) : 1
  return Number.isFinite(amount) && amount > 0 ? amount : 1
}

async function searchExchangeRate(query: string, signal?: AbortSignal): Promise<WebSearchProviderResponse | undefined> {
  if (!/(?:汇率|兑换|换算|兑)|\b(?:exchange\s+rate|convert)\b/i.test(query)) {
    return undefined
  }

  const pair = extractCurrencyPair(query)
  if (!pair) return undefined

  const [base, quote] = pair
  const amount = extractAmount(query)
  const sourceUrl = `https://api.frankfurter.dev/v2/rate/${base}/${quote}`
  const data = await fetchStructuredJson<FrankfurterRate>(sourceUrl, signal)
  if (typeof data.rate !== 'number') {
    throw new Error('Frankfurter returned no usable exchange rate')
  }

  const converted = amount * data.rate
  return {
    query,
    results: [
      {
        title: `${base}/${quote} reference exchange rate`,
        url: sourceUrl,
        content: [
          `Reference date: ${data.date || 'latest available'}`,
          `Base currency: ${data.base || base}`,
          `Quote currency: ${data.quote || quote}`,
          `Reference rate: 1 ${base} = ${data.rate} ${quote}`,
          `Converted amount: ${amount} ${base} = ${converted} ${quote}`,
          'Data source: Frankfurter. Rates are reference rates and may differ from bank or payment-provider settlement rates.'
        ].join('\n')
      }
    ]
  }
}

export function extractWeatherLocation(query: string): string | undefined {
  const normalized = query.trim()

  const chinesePatterns = [
    /(?:请|帮我|麻烦)?(?:查询|查一下|查看|搜索|告诉我)?\s*([\p{Script=Han}]{2,12}?)(?=未来\s*\d*\s*小时|今天|明天|后天|接下来|天气|气温|降雨|降水)/u,
    /([\p{Script=Han}]{2,12}?)(?=(?:未来\s*\d*\s*小时|今天|明天|后天|接下来)?(?:的)?(?:天气|气温|降雨|降水))/u,
    /(?:天气|气温|降雨|降水)(?:预报)?(?:在|为|关于)?\s*([\p{Script=Han}]{2,12})/u
  ]
  for (const pattern of chinesePatterns) {
    const match = normalized.match(pattern)
    const location = match?.[1]
      ?.replace(/^(?:请|帮我|麻烦|查询|查一下|查看|搜索|告诉我)+/u, '')
      .replace(/市$/u, '')
      .trim()
    if (location && location.length >= 2) return location
  }

  const englishMatch = normalized.match(/\bweather\s+(?:in|for)\s+([a-z][a-z .'-]{1,40})/i)
  return englishMatch?.[1]?.trim()
}

async function searchWeather(query: string, signal?: AbortSignal): Promise<WebSearchProviderResponse | undefined> {
  if (!/(?:天气|气温|降雨|降水|weather|forecast)/i.test(query)) {
    return undefined
  }

  const locationName = extractWeatherLocation(query)
  if (!locationName) return undefined

  const geocodingUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationName)}&count=1&language=zh&format=json`
  const geocoding = await fetchStructuredJson<OpenMeteoGeocodingResponse>(geocodingUrl, signal)
  const location = geocoding.results?.[0]
  if (!location) return undefined

  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast')
  forecastUrl.searchParams.set('latitude', String(location.latitude))
  forecastUrl.searchParams.set('longitude', String(location.longitude))
  forecastUrl.searchParams.set('timezone', 'auto')
  forecastUrl.searchParams.set('forecast_days', '2')
  forecastUrl.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m'
  )
  forecastUrl.searchParams.set('hourly', 'temperature_2m,precipitation_probability,precipitation,weather_code')
  forecastUrl.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max')

  const forecast = await fetchStructuredJson<OpenMeteoForecastResponse>(forecastUrl.toString(), signal)
  const dailyLines = (forecast.daily?.time ?? []).slice(0, 2).map((date, index) => {
    const max = forecast.daily?.temperature_2m_max?.[index]
    const min = forecast.daily?.temperature_2m_min?.[index]
    const rainChance = forecast.daily?.precipitation_probability_max?.[index]
    return `${date}: min ${min ?? 'n/a'} C, max ${max ?? 'n/a'} C, max precipitation probability ${rainChance ?? 'n/a'}%`
  })
  const hourlyTimes = forecast.hourly?.time ?? []
  const currentTime = forecast.current?.time
  const currentIndex = currentTime
    ? Math.max(
        0,
        hourlyTimes.findIndex((time) => time >= currentTime)
      )
    : 0
  const hourlyLines = hourlyTimes
    .slice(currentIndex, currentIndex + 24)
    .map((time, relativeIndex) => {
      const index = currentIndex + relativeIndex
      const rainChance = forecast.hourly?.precipitation_probability?.[index]
      const precipitation = forecast.hourly?.precipitation?.[index]
      return {
        relativeIndex,
        rainChance: rainChance ?? 0,
        precipitation: precipitation ?? 0,
        text: `${time}: ${forecast.hourly?.temperature_2m?.[index] ?? 'n/a'} C, precipitation probability ${rainChance ?? 'n/a'}%, precipitation ${precipitation ?? 'n/a'} mm`
      }
    })
    .filter(
      ({ relativeIndex, rainChance, precipitation }) => relativeIndex % 3 === 0 || rainChance >= 40 || precipitation > 0
    )
    .map(({ text }) => text)

  return {
    query,
    results: [
      {
        title: `${location.name} weather forecast from Open-Meteo`,
        url: forecastUrl.toString(),
        content: [
          `Retrieved at: ${new Date().toISOString()}`,
          `Location: ${location.name}, ${location.admin1 || location.country || ''}`,
          `Forecast time zone: ${forecast.timezone || location.timezone || 'unknown'}`,
          `Current observation time: ${forecast.current?.time || 'unknown'}`,
          `Current temperature: ${forecast.current?.temperature_2m ?? 'n/a'} C`,
          `Feels like: ${forecast.current?.apparent_temperature ?? 'n/a'} C`,
          `Current precipitation: ${forecast.current?.precipitation ?? 'n/a'} mm`,
          `Current wind speed: ${forecast.current?.wind_speed_10m ?? 'n/a'} km/h`,
          '',
          'Daily summary:',
          ...dailyLines,
          '',
          'Next 24 hours (3-hour intervals plus precipitation periods):',
          ...hourlyLines,
          '',
          'Data source: Open-Meteo. Forecasts can change as new model runs become available.'
        ].join('\n')
      }
    ]
  }
}

function extractRequestedLookbackHours(query: string): number | undefined {
  const hourMatch = query.match(/(?:最近|近|过去)\s*(\d{1,3})\s*(?:个)?小时/u)
  if (hourMatch) return Number(hourMatch[1])
  if (/(?:今天|今日|当天)/u.test(query)) return 24
  if (/(?:本周|近一周|最近一周)/u.test(query)) return 24 * 7
  return undefined
}

function formatChinaDate(timestampMs: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(timestampMs))
}

function getFreshnessLabel(publishedAt: number | undefined, lookbackHours: number | undefined): string {
  if (!publishedAt || !lookbackHours) return 'Freshness window: not independently constrained.'
  const ageHours = Math.max(0, (Date.now() - publishedAt) / 3_600_000)
  return ageHours <= lookbackHours
    ? `Freshness: within the requested ${lookbackHours}-hour window (${ageHours.toFixed(1)} hours old).`
    : `Freshness warning: outside the requested ${lookbackHours}-hour window (${ageHours.toFixed(1)} hours old).`
}

function decodeBingNewsUrl(value: string): string {
  try {
    const url = new URL(value)
    const target = url.searchParams.get('url')
    return target ? decodeURIComponent(target) : value.replace(/^http:/, 'https:')
  } catch {
    return value
  }
}

function stripHtml(value: string): string {
  const document = new DOMParser().parseFromString(value, 'text/html')
  return document.body.textContent?.replace(/\s+/g, ' ').trim() || value
}

function normalizeNewsQuery(query: string): string {
  const cleaned = query
    .replace(/(?:请|帮我|麻烦|查询|搜索|总结|整理|列出|告诉我)/gu, ' ')
    .replace(/(?:最近|近|过去)\s*\d{1,3}\s*(?:个)?小时/gu, ' ')
    .replace(/(?:今天|今日|当天|最新|实时|最值得关注|前\s*\d+|Top\s*\d+)/giu, ' ')
    .replace(/(?:并|以及)?说明每条新闻的发布时间和来源/gu, ' ')
    .replace(/[，。；：、!?！？]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || query.trim()
}

async function searchSinaFinanceNews(
  query: string,
  signal?: AbortSignal
): Promise<WebSearchProviderResponse | undefined> {
  if (
    !/(?:财经|金融|经济|股市|证券|基金|商业).*(?:新闻|资讯|动态|热点)|(?:新闻|资讯|动态|热点).*(?:财经|金融|经济|股市|证券|基金|商业)/u.test(
      query
    )
  ) {
    return undefined
  }

  const sourceUrl = 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=20&page=1'
  const data = await fetchStructuredJson<SinaFinanceResponse>(sourceUrl, signal)
  const items = data.result?.data ?? []
  const lookbackHours = extractRequestedLookbackHours(query)
  const normalizedItems = items
    .map((item) => ({
      ...item,
      publishedAt: item.ctime && Number.isFinite(Number(item.ctime)) ? Number(item.ctime) * 1000 : undefined
    }))
    .filter((item) => item.title && item.url)
  const freshItems = lookbackHours
    ? normalizedItems.filter((item) => item.publishedAt && Date.now() - item.publishedAt <= lookbackHours * 3_600_000)
    : normalizedItems
  const selectedItems = (freshItems.length ? freshItems : normalizedItems).slice(0, 10)

  if (!selectedItems.length) return undefined

  const coverage = lookbackHours
    ? freshItems.length
      ? `${freshItems.length} feed items matched the requested ${lookbackHours}-hour window.`
      : `No feed item matched the requested ${lookbackHours}-hour window; these are the latest available items and must be labeled as outside the window.`
    : 'The feed returned its latest available finance items.'

  return {
    query,
    results: selectedItems.map((item) => ({
      title: item.title || 'Sina Finance news item',
      url: item.url || sourceUrl,
      content: [
        `Feed retrieved at (Asia/Shanghai): ${formatChinaDate(Date.now())}`,
        `Feed coverage: ${coverage}`,
        `Published at (Asia/Shanghai): ${item.publishedAt ? formatChinaDate(item.publishedAt) : 'unknown'}`,
        `Publisher: ${item.media_name || 'Sina Finance'}`,
        getFreshnessLabel(item.publishedAt, lookbackHours),
        `Summary: ${item.intro?.replace(/\s+/g, ' ').trim() || 'No summary supplied by the feed.'}`,
        'Data source: Sina Finance rolling news feed.'
      ].join('\n')
    }))
  }
}

async function searchBingNews(query: string, signal?: AbortSignal): Promise<WebSearchProviderResponse | undefined> {
  if (!/(?:新闻|资讯|行业动态|news|headlines)/i.test(query) || /(?:微博|热搜|热榜)/u.test(query)) {
    return undefined
  }

  const newsQuery = normalizeNewsQuery(query)
  const sourceUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(newsQuery)}&format=rss&setlang=zh-cn&mkt=zh-CN&cc=cn`
  const xml = await fetchStructuredText(sourceUrl, signal)
  const parsed = new XMLParser({ ignoreAttributes: false, trimValues: true }).parse(xml) as {
    rss?: { channel?: { item?: BingNewsItem | BingNewsItem[] } }
  }
  const rawItems = parsed.rss?.channel?.item
  const items = (Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [])
    .map((item) => ({
      ...item,
      publishedAt: item.pubDate ? Date.parse(item.pubDate) : undefined
    }))
    .filter((item) => item.title && item.link)
  const lookbackHours = extractRequestedLookbackHours(query)
  const freshItems = lookbackHours
    ? items.filter((item) => item.publishedAt && Date.now() - item.publishedAt <= lookbackHours * 3_600_000)
    : items
  const selectedItems = (freshItems.length ? freshItems : items).slice(0, 8)

  if (!selectedItems.length) return undefined

  const coverage = lookbackHours
    ? freshItems.length
      ? `${freshItems.length} feed items matched the requested ${lookbackHours}-hour window.`
      : `No feed item matched the requested ${lookbackHours}-hour window; these are the latest available items and must be labeled as outside the window.`
    : 'The feed returned its latest available news items.'

  return {
    query,
    results: selectedItems.map((item) => ({
      title: item.title || 'Bing News item',
      url: decodeBingNewsUrl(item.link || sourceUrl),
      content: [
        `Feed retrieved at (Asia/Shanghai): ${formatChinaDate(Date.now())}`,
        `Feed coverage: ${coverage}`,
        `Published at (Asia/Shanghai): ${item.publishedAt ? formatChinaDate(item.publishedAt) : 'unknown'}`,
        getFreshnessLabel(item.publishedAt, lookbackHours),
        `Summary: ${stripHtml(item.description || 'No summary supplied by the feed.')}`,
        'Data source: Bing News RSS.'
      ].join('\n')
    }))
  }
}

async function searchNews(query: string, signal?: AbortSignal): Promise<WebSearchProviderResponse | undefined> {
  return (await searchSinaFinanceNews(query, signal)) ?? (await searchBingNews(query, signal))
}

async function searchWeiboHot(query: string, signal?: AbortSignal): Promise<WebSearchProviderResponse | undefined> {
  if (!/(?:微博|weibo)/i.test(query) || !/(?:热搜|热榜|热点|排行|trending)/i.test(query)) {
    return undefined
  }

  const sourceUrl = 'https://60s.viki.moe/v2/weibo'
  const data = await fetchStructuredJson<WeiboHotResponse>(sourceUrl, signal)
  if (data.code !== 200 || !data.data?.length) return undefined

  const requestedCount = Number(query.match(/(?:前|top)\s*(\d{1,2})/i)?.[1] || 10)
  const count = Math.min(Math.max(requestedCount, 1), 20)
  const retrievedAt = formatChinaDate(Date.now())

  return {
    query,
    results: data.data.slice(0, count).map((item, index) => ({
      title: item.title || `Weibo hot topic #${index + 1}`,
      url: item.link || sourceUrl,
      content: [
        `Rank: ${index + 1}`,
        `Topic: ${item.title || 'unknown'}`,
        `Heat value: ${item.hot_value ?? 'unknown'}`,
        `Retrieved at (Asia/Shanghai): ${retrievedAt}`,
        'Data source: 60s open-source Weibo hot-list aggregation. Rankings change continuously.'
      ].join('\n')
    }))
  }
}

async function searchNodeLts(query: string, signal?: AbortSignal): Promise<WebSearchProviderResponse | undefined> {
  if (!/node(?:\.js)?/i.test(query) || !/(?:LTS|长期支持|最新版本|最新版|current|latest)/i.test(query)) {
    return undefined
  }

  const sourceUrl = 'https://nodejs.org/dist/index.json'
  const releases = await fetchStructuredJson<NodeRelease[]>(sourceUrl, signal)
  const latestLts = releases.find((release) => Boolean(release.lts))
  const latestCurrent = releases[0]
  if (!latestLts) return undefined

  return {
    query,
    results: [
      {
        title: 'Official Node.js release index',
        url: sourceUrl,
        content: [
          `Retrieved at: ${new Date().toISOString()}`,
          `Latest LTS: ${latestLts.version}`,
          `LTS codename: ${latestLts.lts || 'unknown'}`,
          `LTS release date: ${latestLts.date}`,
          `Latest current release: ${latestCurrent?.version || 'unknown'}`,
          `Latest current release date: ${latestCurrent?.date || 'unknown'}`,
          'Data source: the official Node.js distribution release index.'
        ].join('\n')
      }
    ]
  }
}

async function searchStructuredSource(
  query: string,
  signal?: AbortSignal
): Promise<WebSearchProviderResponse | undefined> {
  return (
    (await searchExchangeRate(query, signal)) ??
    (await searchWeather(query, signal)) ??
    (await searchWeiboHot(query, signal)) ??
    (await searchNews(query, signal)) ??
    (await searchNodeLts(query, signal))
  )
}

function hasCategoryRelevance(query: string, response: WebSearchProviderResponse): boolean {
  const corpus = response.results
    .map((result) => `${result.title}\n${result.content}\n${result.url}`)
    .join('\n')
    .toLowerCase()

  if (/(?:天气|气温|降雨|降水|weather|forecast)/i.test(query)) {
    const location = extractWeatherLocation(query)?.toLowerCase()
    return (!location || corpus.includes(location)) && /天气|气温|降雨|降水|weather|forecast|temperature/.test(corpus)
  }
  if (/(?:微博|weibo)/i.test(query) && /(?:热搜|热榜|热点|trending)/i.test(query)) {
    return /微博|weibo/.test(corpus) && /热搜|热榜|热点|trending/.test(corpus)
  }
  if (/(?:b站|哔哩哔哩|bilibili)/i.test(query) && /(?:榜|排行|视频|ranking)/i.test(query)) {
    return /b站|哔哩哔哩|bilibili/.test(corpus) && /榜|排行|视频|ranking/.test(corpus)
  }
  if (/(?:财经|金融|经济|股市|证券|基金|商业)/u.test(query) && /(?:新闻|资讯|动态|热点|news)/i.test(query)) {
    return /财经|金融|经济|股市|证券|基金|商业|finance|economy|market/.test(corpus)
  }

  return true
}

function buildBrowserQuery(query: string): string {
  if (/(?:天气|气温|降雨|降水|weather|forecast)/i.test(query)) {
    const location = extractWeatherLocation(query)
    return location ? `${location} 24-hour weather precipitation minimum maximum temperature` : query
  }
  if (/(?:微博|weibo)/i.test(query) && /(?:热搜|热榜|热点|trending)/i.test(query)) {
    return '微博热搜 实时榜'
  }
  if (/(?:b站|哔哩哔哩|bilibili)/i.test(query) && /(?:榜|排行|视频|ranking)/i.test(query)) {
    return 'B站 哔哩哔哩 实时热门 视频榜'
  }
  if (/(?:财经|金融|经济|股市|证券|基金|商业)/u.test(query) && /(?:新闻|资讯|动态|热点|news)/i.test(query)) {
    return `${normalizeNewsQuery(query)} ${formatChinaDate(Date.now()).slice(0, 10)}`.trim()
  }

  return query.length > 180 ? query.slice(0, 180) : query
}

export default class AutoFreeProvider extends BaseWebSearchProvider {
  public async search(
    query: string,
    websearch: WebSearchState,
    httpOptions?: RequestInit
  ): Promise<WebSearchProviderResponse> {
    if (!query.trim()) {
      throw new Error('Search query cannot be empty')
    }

    const timeResult = searchCurrentTime(query)
    if (timeResult) {
      return timeResult
    }

    try {
      const structuredResult = await runSearchStage(
        'Structured free search',
        STRUCTURED_SEARCH_TIMEOUT_MS,
        httpOptions,
        (options) => searchStructuredSource(query, options.signal ?? undefined)
      )
      if (structuredResult?.results.length) {
        return structuredResult
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      logger.warn('Structured free search failed; falling back to general search', error as Error)
    }

    try {
      const exaProvider = new ExaMcpProvider({
        id: 'exa-mcp',
        name: 'ExaMCP',
        apiHost: 'https://mcp.exa.ai/mcp'
      })
      const response = await runSearchStage('No-key Exa search', EXA_SEARCH_TIMEOUT_MS, httpOptions, (options) =>
        exaProvider.search(query, websearch, options)
      )
      if (response.results.some((result) => result.url && result.content) && hasCategoryRelevance(query, response)) {
        return response
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      logger.warn('No-key Exa search failed; falling back to browser search', error as Error)
    }

    const [
      { default: LocalBaiduProvider },
      { default: LocalBingProvider },
      { default: LocalDuckDuckGoProvider },
      { default: LocalGoogleProvider }
    ] = await Promise.all([
      import('./LocalBaiduProvider'),
      import('./LocalBingProvider'),
      import('./LocalDuckDuckGoProvider'),
      import('./LocalGoogleProvider')
    ])

    const browserProviders = [
      {
        name: 'Bing',
        instance: new LocalBingProvider({
          id: 'local-bing',
          name: 'Bing',
          url: 'https://cn.bing.com/search?q=%s&setlang=zh-cn&cc=cn',
          usingBrowser: true
        })
      },
      {
        name: 'DuckDuckGo',
        instance: new LocalDuckDuckGoProvider({
          id: 'local-duckduckgo',
          name: 'DuckDuckGo',
          url: 'https://html.duckduckgo.com/html/?q=%s',
          usingBrowser: true
        })
      },
      {
        name: 'Baidu',
        instance: new LocalBaiduProvider({
          id: 'local-baidu',
          name: 'Baidu',
          url: 'https://www.baidu.com/s?wd=%s',
          usingBrowser: true
        })
      },
      {
        name: 'Google',
        instance: new LocalGoogleProvider({
          id: 'local-google',
          name: 'Google',
          url: 'https://www.google.com/search?q=%s&hl=zh-CN',
          usingBrowser: true
        })
      }
    ]

    const browserQuery = buildBrowserQuery(query)
    let lastError: unknown
    for (const provider of browserProviders) {
      try {
        const response = await runSearchStage(
          `${provider.name} browser search`,
          BROWSER_SEARCH_TIMEOUT_MS,
          httpOptions,
          (options) => provider.instance.search(browserQuery, websearch, options)
        )
        if (response.results.length && hasCategoryRelevance(query, response)) {
          return { ...response, query }
        }
        logger.info(`Search results from ${provider.name} were not relevant enough; trying the next source`)
      } catch (error) {
        if (isAbortError(error)) throw error
        lastError = error
        logger.warn(`Browser search failed with ${provider.name}`, error as Error)
      }
    }

    throw new Error(
      `Free search sources are temporarily unavailable${lastError instanceof Error ? `: ${lastError.message}` : ''}`
    )
  }
}
