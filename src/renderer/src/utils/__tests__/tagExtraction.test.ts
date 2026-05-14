import { describe, expect, it } from 'vitest'

import { TagExtractor } from '../tagExtraction'

describe('TagExtractor', () => {
  it('extracts complete tag content in one pass', () => {
    const extractor = new TagExtractor({
      openingTag: '<think>',
      closingTag: '</think>'
    })

    const results = extractor.processText('<think>Hello</think>')

    expect(results).toEqual([
      { content: 'Hello', isTagContent: true, complete: false },
      { content: '', isTagContent: false, complete: true, tagContentExtracted: 'Hello' }
    ])
  })

  it('preserves text outside the tag', () => {
    const extractor = new TagExtractor({
      openingTag: '<think>',
      closingTag: '</think>'
    })

    const results = extractor.processText('before<think>inside</think>after')

    expect(results).toEqual([
      { content: 'before', isTagContent: false, complete: false },
      { content: 'inside', isTagContent: true, complete: false },
      { content: '', isTagContent: false, complete: true, tagContentExtracted: 'inside' },
      { content: 'after', isTagContent: false, complete: false }
    ])
  })

  it('handles streaming chunks split across tag boundaries', () => {
    const extractor = new TagExtractor({
      openingTag: '<think>',
      closingTag: '</think>'
    })

    expect(extractor.processText('<thi')).toEqual([])
    expect(extractor.processText('nk>Hello')).toEqual([{ content: 'Hello', isTagContent: true, complete: false }])
    expect(extractor.processText('</think>')).toEqual([
      { content: '', isTagContent: false, complete: true, tagContentExtracted: 'Hello' }
    ])
  })

  it('adds separators between repeated tag payloads when configured', () => {
    const extractor = new TagExtractor({
      openingTag: '<think>',
      closingTag: '</think>',
      separator: '\n---\n'
    })

    extractor.processText('<think>One</think>')
    const results = extractor.processText('<think>Two</think>')

    expect(results[0]).toEqual({
      content: '\n---\nTwo',
      isTagContent: true,
      complete: false
    })
  })

  it('returns unfinished tag content from finalize and clears on reset', () => {
    const extractor = new TagExtractor({
      openingTag: '<think>',
      closingTag: '</think>'
    })

    extractor.processText('<think>Partial')
    expect(extractor.finalize()).toEqual({
      content: '',
      isTagContent: false,
      complete: true,
      tagContentExtracted: 'Partial'
    })

    extractor.reset()
    expect(extractor.finalize()).toBeNull()
  })
})
