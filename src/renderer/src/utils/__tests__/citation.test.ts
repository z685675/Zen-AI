import type { GroundingSupport } from '@google/genai'
import type { Citation } from '@renderer/types'
import { WEB_SEARCH_SOURCE } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

import {
  determineCitationSource,
  generateCitationTag,
  mapCitationMarksToTags,
  normalizeCitationMarks,
  withCitationTags
} from '../citation'

vi.mock('@renderer/utils/formats', () => ({
  cleanMarkdownContent: vi.fn((content: string) => content.replace(/[*_~`]/g, '')),
  encodeHTML: vi.fn((content: string) =>
    content.replace(/[&<>"']/g, (match) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;'
      }
      return entities[match]
    })
  )
}))

describe('citation utils', () => {
  const createCitationMap = (citations: Citation[]) => new Map(citations.map((citation) => [citation.number, citation]))

  it('finds the first available citation source', () => {
    expect(
      determineCitationSource([
        { citationBlockId: '1' },
        { citationBlockId: '2', citationBlockSource: WEB_SEARCH_SOURCE.GEMINI }
      ])
    ).toBe(WEB_SEARCH_SOURCE.GEMINI)
  })

  it('normalizes default numeric citations', () => {
    const result = normalizeCitationMarks(
      'Text with [1] and [2]',
      createCitationMap([
        { number: 1, url: 'https://one.example' },
        { number: 2, url: 'https://two.example' }
      ])
    )

    expect(result).toBe('Text with [cite:1] and [cite:2]')
  })

  it('skips replacing citations inside inline code', () => {
    const result = normalizeCitationMarks(
      'Use `const a = [1]` and [1]',
      createCitationMap([{ number: 1, url: 'https://example.com' }])
    )

    expect(result).toContain('`const a = [1]`')
    expect(result).toContain('and [cite:1]')
  })

  it('normalizes OpenAI-style citations', () => {
    const result = normalizeCitationMarks(
      'Answer [<sup>1</sup>](https://example.com)',
      createCitationMap([{ number: 1, url: 'https://example.com' }]),
      WEB_SEARCH_SOURCE.OPENAI
    )

    expect(result).toBe('Answer [cite:1]')
  })

  it('inserts Gemini citations using UTF-8 byte offsets', () => {
    const metadata: GroundingSupport[] = [
      {
        segment: { startIndex: 0, endIndex: 11, text: '你好world' },
        groundingChunkIndices: [0]
      }
    ]
    const result = normalizeCitationMarks(
      '你好world end',
      createCitationMap([{ number: 1, url: 'https://example.com', metadata }]),
      WEB_SEARCH_SOURCE.GEMINI
    )

    expect(result).toBe('你好world[cite:1] end')
  })

  it('maps normalized marks to rendered tags', () => {
    const result = mapCitationMarksToTags(
      'Text [cite:1]',
      createCitationMap([{ number: 1, url: 'https://example.com', title: 'Example' }])
    )

    expect(result).toContain('data-citation=')
    expect(result).toContain('1</sup>](https://example.com)')
  })

  it('builds final citation-tagged content end to end', () => {
    const result = withCitationTags('Text [1]', [{ number: 1, url: 'https://example.com', title: 'Example' }])

    expect(result).toContain('data-citation=')
    expect(result).toContain('https://example.com')
  })

  it('escapes pipes in citation payloads and URLs', () => {
    const result = generateCitationTag({
      number: 1,
      url: 'https://example.com/a|b',
      title: 'Foo | Bar'
    })

    expect(result).toContain('&#124;')
    expect(result).toContain('%7C')
  })
})
