import { describe, expect, it } from 'vitest'

import {
  cleanLinkCommas,
  completeLinks,
  convertLinks,
  extractUrlsFromMarkdown,
  flushLinkConverterBuffer
} from '../linkConverter'

describe('linkConverter', () => {
  it('converts normal markdown links into numbered references', () => {
    const result = convertLinks('See [GitHub](https://github.com) now', true)

    expect(result.text).toBe('See GitHub [<sup>1</sup>](https://github.com) now')
    expect(result.hasBufferedContent).toBe(false)
  })

  it('keeps bracket placeholders that are not real links', () => {
    const result = convertLinks('Configure [owner] and [repo]', true)

    expect(result.text).toBe('Configure [owner] and [repo]')
    expect(result.hasBufferedContent).toBe(false)
  })

  it('buffers incomplete links and completes them with later chunks', () => {
    const first = convertLinks('Visit [example.com](', true)
    const second = convertLinks('https://example.com) today', false)

    expect(first.text).toBe('Visit ')
    expect(first.hasBufferedContent).toBe(true)
    expect(second.text).toBe('[<sup>1</sup>](https://example.com) today')
    expect(second.hasBufferedContent).toBe(false)
  })

  it('completes empty citation links from web search results', () => {
    expect(completeLinks('Answer [<sup>1</sup>]()', [{ link: 'https://example.com' }])).toBe(
      'Answer [<sup>1</sup>](https://example.com)'
    )
  })

  it('extracts unique URLs from markdown', () => {
    expect(extractUrlsFromMarkdown('[a](https://a.com) and [b](https://b.com) and [a2](https://a.com)')).toEqual([
      'https://a.com',
      'https://b.com'
    ])
  })

  it('removes commas between adjacent links', () => {
    expect(cleanLinkCommas('[a](https://a.com), [b](https://b.com)')).toBe('[a](https://a.com)[b](https://b.com)')
  })

  it('flushes any remaining buffered content', () => {
    convertLinks('Leftover [x](', true)
    expect(flushLinkConverterBuffer()).toBe('[x](')
  })
})
