import { loggerService } from '@logger'

import type { SearchItem } from './LocalSearchProvider'
import LocalSearchProvider from './LocalSearchProvider'

const logger = loggerService.withContext('LocalBingProvider')

export default class LocalBingProvider extends LocalSearchProvider {
  protected parseValidUrls(htmlContent: string): SearchItem[] {
    const results: SearchItem[] = []

    try {
      // Parse HTML string into a DOM document
      const parser = new DOMParser()
      const doc = parser.parseFromString(htmlContent, 'text/html')

      const items = doc.querySelectorAll('#b_results .b_algo')
      items.forEach((item) => {
        const node = item.querySelector<HTMLAnchorElement>('h2 a')
        if (node) {
          const decodedUrl = this.decodeBingUrl(node.href)
          results.push({
            title: node.textContent || '',
            url: decodedUrl,
            snippet: item.querySelector('.b_caption p, .b_snippet')?.textContent?.trim()
          })
        }
      })
    } catch (error) {
      logger.error('Failed to parse Bing search HTML:', error as Error)
    }
    return results
  }

  /**
   * Decode Bing redirect URL to get the actual URL
   * Bing URLs are in format: https://www.bing.com/ck/a?...&u=a1aHR0cHM6Ly93d3cudG91dGlhby5jb20...
   * The 'u' parameter contains Base64 encoded URL with 'a1' prefix
   */
  private decodeBingUrl(bingUrl: string): string {
    try {
      const url = new URL(bingUrl)
      const encodedUrl = url.searchParams.get('u')

      if (!encodedUrl) {
        return bingUrl // Return original if no 'u' parameter
      }

      // Remove the 'a1' prefix and decode Base64
      const base64Part = encodedUrl.replace(/^a1/, '').replace(/-/g, '+').replace(/_/g, '/')
      const paddedBase64 = base64Part.padEnd(Math.ceil(base64Part.length / 4) * 4, '=')
      const decodedUrl = atob(paddedBase64)

      // Validate the decoded URL
      if (decodedUrl.startsWith('http')) {
        return decodedUrl
      }

      return bingUrl // Return original if decoded URL is invalid
    } catch (error) {
      logger.warn('Failed to decode Bing URL:', error as Error)
      return bingUrl // Return original URL if decoding fails
    }
  }
}
