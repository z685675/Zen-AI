import type { KnowledgeReference, WebSearchProviderResult } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { consolidateReferencesByUrl, selectReferences } from '../websearch'

const raw = (url: string, title: string): WebSearchProviderResult => ({
  url,
  title,
  content: `${title} content`
})

const ref = (sourceUrl: string, content: string, id: number): KnowledgeReference => ({
  id,
  sourceUrl,
  content,
  type: 'url'
})

describe('websearch utils', () => {
  it('consolidates references by URL', () => {
    expect(
      consolidateReferencesByUrl(
        [raw('https://a.com', 'A')],
        [ref('https://a.com', 'part 1', 1), ref('https://a.com', 'part 2', 2)]
      )
    ).toEqual([
      {
        title: 'A',
        url: 'https://a.com',
        content: 'part 1\n\n---\n\npart 2'
      }
    ])
  })

  it('ignores references without matching raw results', () => {
    expect(consolidateReferencesByUrl([raw('https://a.com', 'A')], [ref('https://b.com', 'part 1', 1)])).toEqual([])
  })

  it('selects references in raw-result round robin order', () => {
    const result = selectReferences(
      [raw('https://z.com', 'Z'), raw('https://a.com', 'A')],
      [ref('https://a.com', 'A1', 1), ref('https://z.com', 'Z1', 2), ref('https://z.com', 'Z2', 3)],
      3
    )

    expect(result.map((item) => item.content)).toEqual(['Z1', 'A1', 'Z2'])
  })

  it('returns an empty array for empty or invalid inputs', () => {
    expect(selectReferences([], [], 3)).toEqual([])
    expect(selectReferences([raw('https://a.com', 'A')], [], 3)).toEqual([])
    expect(selectReferences([raw('https://a.com', 'A')], [ref('https://b.com', 'B1', 1)], 3)).toEqual([])
  })
})
