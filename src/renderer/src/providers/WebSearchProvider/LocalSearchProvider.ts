import { loggerService } from '@logger'
import { nanoid } from '@reduxjs/toolkit'
import type { WebSearchState } from '@renderer/store/websearch'
import type { WebSearchProvider, WebSearchProviderResponse, WebSearchProviderResult } from '@renderer/types'
import { createAbortPromise } from '@renderer/utils/abortController'
import { isAbortError } from '@renderer/utils/error'
import { fetchWebContent, noContent } from '@renderer/utils/fetch'

import BaseWebSearchProvider from './BaseWebSearchProvider'

const logger = loggerService.withContext('LocalSearchProvider')

export interface SearchItem {
  title: string
  url: string
  snippet?: string
}

const SOURCE_ENRICHMENT_LIMIT = 3

export function mergeSearchItemsWithEnrichedContent(
  items: SearchItem[],
  enrichedResults: WebSearchProviderResult[]
): WebSearchProviderResult[] {
  return items.map((item, index) => {
    const enriched = enrichedResults[index]
    if (enriched && enriched.content !== noContent) {
      return {
        ...enriched,
        title: enriched.title || item.title,
        url: enriched.url || item.url
      }
    }

    const snippet = item.snippet?.trim()
    return {
      title: item.title || item.url,
      url: item.url,
      content: snippet
        ? `Search result snippet: ${snippet}`
        : `Search result title: ${item.title || item.url}. The source page could not be fully extracted.`
    }
  })
}

export default class LocalSearchProvider extends BaseWebSearchProvider {
  constructor(provider: WebSearchProvider) {
    if (!provider || !provider.url) {
      throw new Error('Provider URL is required')
    }
    super(provider)
  }

  public async search(
    query: string,
    websearch: WebSearchState,
    httpOptions?: RequestInit
  ): Promise<WebSearchProviderResponse> {
    const uid = nanoid()
    try {
      if (!query.trim()) {
        throw new Error('Search query cannot be empty')
      }
      if (!this.provider.url) {
        throw new Error('Provider URL is required')
      }

      const cleanedQuery = (query.split('\r\n')[1] ?? query).trim()
      const url = this.provider.url.replace('%s', encodeURIComponent(cleanedQuery))
      let content: string = ''
      const promisesToRace: [Promise<string>] = [window.api.searchService.openUrlInSearchWindow(uid, url)]
      if (httpOptions?.signal) {
        const abortPromise = createAbortPromise(httpOptions.signal, promisesToRace[0])
        promisesToRace.push(abortPromise)
      }
      content = await Promise.race(promisesToRace)

      // Parse the content to extract URLs and metadata
      const searchItems = this.parseValidUrls(content).slice(0, websearch.maxResults)

      const validItems = searchItems
        .filter((item) => item.url.startsWith('http') || item.url.startsWith('https'))
        .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index)
        .slice(0, websearch.maxResults)

      // Search snippets are the minimum viable result. Source-page extraction
      // enriches the first few hits but must never erase usable search results.
      const fetchPromises = validItems.slice(0, SOURCE_ENRICHMENT_LIMIT).map(async (item) => {
        return await fetchWebContent(item.url, 'markdown', this.provider.usingBrowser, httpOptions)
      })
      const enrichedResults = await Promise.all(fetchPromises)
      const results = mergeSearchItemsWithEnrichedContent(validItems, enrichedResults)

      return {
        query: query,
        results
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      logger.error('Local search failed:', error as Error)
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      await window.api.searchService.closeSearchWindow(uid)
    }
  }

  // oxlint-disable-next-line @typescript-eslint/no-unused-vars
  protected parseValidUrls(_htmlContent: string): SearchItem[] {
    throw new Error('Not implemented')
  }
}
