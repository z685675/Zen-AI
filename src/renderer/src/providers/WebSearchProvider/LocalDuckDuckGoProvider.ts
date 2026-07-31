import { loggerService } from '@logger'

import type { SearchItem } from './LocalSearchProvider'
import LocalSearchProvider from './LocalSearchProvider'

const logger = loggerService.withContext('LocalDuckDuckGoProvider')

export default class LocalDuckDuckGoProvider extends LocalSearchProvider {
  protected parseValidUrls(htmlContent: string): SearchItem[] {
    const results: SearchItem[] = []

    try {
      const parser = new DOMParser()
      const doc = parser.parseFromString(htmlContent, 'text/html')

      doc.querySelectorAll('.result').forEach((item) => {
        const link = item.querySelector<HTMLAnchorElement>('.result__a')
        if (!link) return

        const url = new URL(link.href, 'https://html.duckduckgo.com').searchParams.get('uddg') || link.href
        results.push({
          title: link.textContent?.trim() || '',
          url,
          snippet: item.querySelector('.result__snippet')?.textContent?.trim()
        })
      })
    } catch (error) {
      logger.error('Failed to parse DuckDuckGo search HTML:', error as Error)
    }

    return results
  }
}
