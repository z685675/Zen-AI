import { describe, expect, it } from 'vitest'

import { extractInfoFromXML } from '../extract'

describe('extractInfoFromXML', () => {
  it('parses websearch XML with repeated question and link tags', () => {
    const result = extractInfoFromXML(`
      <websearch>
        <question>What is AI?</question>
        <question>What is ML?</question>
        <links>https://example.com/ai</links>
      </websearch>
    `)

    expect(result).toEqual({
      websearch: {
        question: ['What is AI?', 'What is ML?'],
        links: ['https://example.com/ai']
      }
    })
  })

  it('parses knowledge XML', () => {
    const result = extractInfoFromXML(`
      <knowledge>
        <rewrite>rewrite me</rewrite>
        <question>How does it work?</question>
      </knowledge>
    `)

    expect(result).toEqual({
      knowledge: {
        rewrite: 'rewrite me',
        question: ['How does it work?']
      }
    })
  })

  it('keeps wrapper nodes when the XML is nested', () => {
    const result = extractInfoFromXML(`
      <root>
        <websearch>
          <question>Nested question</question>
        </websearch>
      </root>
    `)

    expect(result).toEqual({
      root: {
        websearch: {
          question: ['Nested question']
        }
      }
    })
  })

  it('returns an empty object for empty input', () => {
    expect(extractInfoFromXML('')).toEqual({})
  })
})
