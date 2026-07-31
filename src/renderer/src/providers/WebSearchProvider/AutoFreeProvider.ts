import { loggerService } from '@logger'
import type { WebSearchState } from '@renderer/store/websearch'
import type { WebSearchProviderResponse } from '@renderer/types'

import BaseWebSearchProvider from './BaseWebSearchProvider'
import ExaMcpProvider from './ExaMcpProvider'

const logger = loggerService.withContext('AutoFreeProvider')

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
  const response = await fetch(sourceUrl, { signal })
  if (!response.ok) {
    throw new Error(`Frankfurter request failed (${response.status})`)
  }

  const data = (await response.json()) as FrankfurterRate
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
      const structuredResult = await searchExchangeRate(query, httpOptions?.signal ?? undefined)
      if (structuredResult?.results.length) {
        return structuredResult
      }
    } catch (error) {
      logger.warn('Structured free search failed; falling back to general search', error as Error)
    }

    try {
      const exaProvider = new ExaMcpProvider({
        id: 'exa-mcp',
        name: 'ExaMCP',
        apiHost: 'https://mcp.exa.ai/mcp'
      })
      const response = await exaProvider.search(query, websearch, httpOptions)
      if (response.results.some((result) => result.url && result.content)) {
        return response
      }
    } catch (error) {
      logger.warn('No-key Exa search failed; falling back to browser search', error as Error)
    }

    const [{ default: LocalBaiduProvider }, { default: LocalBingProvider }, { default: LocalGoogleProvider }] =
      await Promise.all([
        import('./LocalBaiduProvider'),
        import('./LocalBingProvider'),
        import('./LocalGoogleProvider')
      ])

    const browserProviders = [
      {
        name: 'Bing',
        instance: new LocalBingProvider({
          id: 'local-bing',
          name: 'Bing',
          url: 'https://cn.bing.com/search?q=%s&ensearch=1',
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
          url: 'https://www.google.com/search?q=%s',
          usingBrowser: true
        })
      }
    ]

    let lastError: unknown
    for (const provider of browserProviders) {
      try {
        const response = await provider.instance.search(query, websearch, httpOptions)
        if (response.results.length) {
          return response
        }
      } catch (error) {
        lastError = error
        logger.warn(`Browser search failed with ${provider.name}`, error as Error)
      }
    }

    throw new Error(
      `Free search sources are temporarily unavailable${lastError instanceof Error ? `: ${lastError.message}` : ''}`
    )
  }
}
