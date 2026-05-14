import { splitToSubTrunks } from '@renderer/services/ShikiStreamTokenizer'
import type { ThemedToken } from 'shiki/types'
import { describe, expect, it } from 'vitest'

import { getReactStyleFromToken } from '../shiki'

const FS_ITALIC = 1
const FS_BOLD = 2
const FS_UNDERLINE = 4

function createThemedToken(partial: Partial<ThemedToken> = {}): ThemedToken {
  return {
    content: 'default-content',
    offset: 0,
    ...partial
  }
}

describe('shiki', () => {
  describe('splitToSubTrunks', () => {
    it('returns the original string when there is no newline', () => {
      const chunk = 'console.log("Hello world")'
      expect(splitToSubTrunks(chunk)).toEqual([chunk])
    })

    it('splits a string with one newline into two parts', () => {
      expect(splitToSubTrunks('const x = 5;\nconsole.log(x)')).toEqual(['const x = 5;', 'console.log(x)'])
    })

    it('splits by the last newline when multiple newlines exist', () => {
      expect(splitToSubTrunks('const x = 5;\nconst y = 10;\nconsole.log(x + y)')).toEqual([
        'const x = 5;\nconst y = 10;',
        'console.log(x + y)'
      ])
    })

    it('handles strings ending with a newline', () => {
      expect(splitToSubTrunks('const x = 5;\nconst y = 10;\n')).toEqual(['const x = 5;\nconst y = 10;', ''])
    })

    it('handles an empty string', () => {
      expect(splitToSubTrunks('')).toEqual([''])
    })
  })

  describe('getReactStyleFromToken', () => {
    it('uses token htmlStyle when available', () => {
      const token = createThemedToken({
        content: 'test',
        htmlStyle: {
          'font-style': 'italic',
          'font-weight': 'bold',
          'background-color': '#f5f5f5',
          'text-decoration': 'underline',
          color: '#ff0000'
        }
      })

      expect(getReactStyleFromToken(token)).toEqual({
        fontStyle: 'italic',
        fontWeight: 'bold',
        backgroundColor: '#f5f5f5',
        textDecoration: 'underline',
        color: '#ff0000'
      })
    })

    it('falls back to getTokenStyleObject when htmlStyle is absent', () => {
      const token = createThemedToken({
        content: 'test',
        color: '#ff0000',
        fontStyle: FS_ITALIC
      })

      expect(getReactStyleFromToken(token)).toEqual({
        fontStyle: 'italic',
        color: '#ff0000'
      })
    })

    it('converts supported CSS properties to React style names', () => {
      const token = createThemedToken({
        content: 'test',
        htmlStyle: {
          'font-style': 'italic',
          'font-weight': 'bold',
          'background-color': '#f5f5f5',
          'text-decoration': 'underline',
          color: '#ff0000',
          'font-family': 'monospace',
          'border-radius': '2px'
        }
      })

      expect(getReactStyleFromToken(token)).toEqual({
        fontStyle: 'italic',
        fontWeight: 'bold',
        backgroundColor: '#f5f5f5',
        textDecoration: 'underline',
        color: '#ff0000',
        'font-family': 'monospace',
        'border-radius': '2px'
      })
    })

    it('keeps unrelated CSS property names unchanged', () => {
      const token = createThemedToken({
        content: 'const',
        offset: 0,
        htmlStyle: {
          color: '#FF0000',
          opacity: '0.8',
          border: '1px solid black'
        }
      })

      expect(getReactStyleFromToken(token)).toEqual({
        color: '#FF0000',
        opacity: '0.8',
        border: '1px solid black'
      })
    })

    it('handles complex style combinations', () => {
      const token = createThemedToken({
        content: 'const',
        offset: 0,
        htmlStyle: {
          color: '#FF0000',
          'font-style': 'italic',
          'font-weight': 'bold',
          'background-color': '#EEEEEE',
          'text-decoration': 'underline',
          opacity: '0.8',
          border: '1px solid black'
        }
      })

      expect(getReactStyleFromToken(token)).toEqual({
        color: '#FF0000',
        fontStyle: 'italic',
        fontWeight: 'bold',
        backgroundColor: '#EEEEEE',
        textDecoration: 'underline',
        opacity: '0.8',
        border: '1px solid black'
      })
    })

    it('handles combined font style flags', () => {
      const token = createThemedToken({
        content: 'const',
        offset: 0,
        color: '#0000FF',
        fontStyle: FS_BOLD | FS_UNDERLINE
      })

      expect(getReactStyleFromToken(token)).toEqual({
        color: '#0000FF',
        fontWeight: 'bold',
        textDecoration: 'underline'
      })
    })

    it('returns an empty object for tokens without style data', () => {
      expect(
        getReactStyleFromToken(
          createThemedToken({
            content: 'const',
            offset: 0
          })
        )
      ).toEqual({})
    })
  })
})
