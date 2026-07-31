import { noContent } from '@renderer/utils/fetch'
import { describe, expect, it } from 'vitest'

import LocalBingProvider from '../LocalBingProvider'
import LocalDuckDuckGoProvider from '../LocalDuckDuckGoProvider'
import { mergeSearchItemsWithEnrichedContent } from '../LocalSearchProvider'

class TestBingProvider extends LocalBingProvider {
  public parse(html: string) {
    return this.parseValidUrls(html)
  }
}

class TestDuckDuckGoProvider extends LocalDuckDuckGoProvider {
  public parse(html: string) {
    return this.parseValidUrls(html)
  }
}

describe('local search providers', () => {
  it('parses Bing titles, decoded URLs, and snippets', () => {
    const targetUrl = 'https://nodejs.org/en/download'
    const encodedUrl = `a1${btoa(targetUrl)}`
    const provider = new TestBingProvider({
      id: 'local-bing',
      name: 'Bing',
      url: 'https://cn.bing.com/search?q=%s'
    })
    const results = provider.parse(`
      <ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://www.bing.com/ck/a?u=${encodedUrl}">Download Node.js</a></h2>
          <div class="b_caption"><p>Official Node.js downloads and LTS releases.</p></div>
        </li>
      </ol>
    `)

    expect(results).toEqual([
      {
        title: 'Download Node.js',
        url: targetUrl,
        snippet: 'Official Node.js downloads and LTS releases.'
      }
    ])
  })

  it('parses the keyless DuckDuckGo HTML results', () => {
    const targetUrl = 'https://example.com/news'
    const provider = new TestDuckDuckGoProvider({
      id: 'local-duckduckgo',
      name: 'DuckDuckGo',
      url: 'https://html.duckduckgo.com/html/?q=%s'
    })
    const results = provider.parse(`
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent(targetUrl)}">Example news</a>
        <a class="result__snippet">A current search result summary.</a>
      </div>
    `)

    expect(results[0]).toEqual({
      title: 'Example news',
      url: targetUrl,
      snippet: 'A current search result summary.'
    })
  })

  it('keeps search snippets when source-page extraction fails', () => {
    const results = mergeSearchItemsWithEnrichedContent(
      [{ title: 'Useful result', url: 'https://example.com', snippet: 'Usable search summary.' }],
      [{ title: 'Error', url: 'https://example.com', content: noContent }]
    )

    expect(results).toEqual([
      {
        title: 'Useful result',
        url: 'https://example.com',
        content: 'Search result snippet: Usable search summary.'
      }
    ])
  })
})
