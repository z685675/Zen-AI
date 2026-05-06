import { describe, expect, it } from 'vitest'

import {
  buildKeywordRegex,
  buildKeywordRegexes,
  buildKeywordUnionRegex,
  type KeywordMatchMode,
  splitKeywordsToTerms
} from '../keywordSearch'

describe('keywordSearch', () => {
  describe('splitKeywordsToTerms', () => {
    it('splits by whitespace and lowercases', () => {
      expect(splitKeywordsToTerms('  Foo\tBAR \n baz  ')).toEqual(['foo', 'bar', 'baz'])
    })

    it('returns empty array for empty input', () => {
      expect(splitKeywordsToTerms('')).toEqual([])
    })

    it('extracts double-quoted phrases as single terms', () => {
      expect(splitKeywordsToTerms('"machine learning" deep')).toEqual(['machine learning', 'deep'])
    })

    it('extracts single-quoted phrases as single terms', () => {
      expect(splitKeywordsToTerms("'neural network' model")).toEqual(['neural network', 'model'])
    })

    it('handles mixed quoted and unquoted terms', () => {
      expect(splitKeywordsToTerms('test "some phrase" end')).toEqual(['test', 'some phrase', 'end'])
    })

    it('handles unclosed quotes gracefully', () => {
      expect(splitKeywordsToTerms('"unclosed phrase')).toEqual(['unclosed phrase'])
    })
  })

  describe('AND logic with buildKeywordRegexes', () => {
    it('every() works with phrase search', () => {
      const terms = splitKeywordsToTerms('"machine learning" deep')
      const regexes = buildKeywordRegexes(terms, { matchMode: 'substring', flags: 'i' })
      expect(regexes.every((r) => r.test('deep machine learning is great'))).toBe(true)
      expect(regexes.every((r) => r.test('deep learning but not machine'))).toBe(false)
    })
  })

  describe('buildKeywordRegex (whole-word)', () => {
    const matchMode: KeywordMatchMode = 'whole-word'

    it('matches standalone tokens but not substrings inside words', () => {
      const regex = buildKeywordRegex('sms', { matchMode })
      expect(regex.test('sms')).toBe(true)
      expect(regex.test('sms,')).toBe(true)
      expect(regex.test('use sms now')).toBe(true)
      expect(regex.test('mechanisms')).toBe(false)
    })

    it('does not match inside longer alphanumeric strings (e.g. API keys)', () => {
      const regex = buildKeywordRegex('sms', { matchMode })
      expect(regex.test('IMr4WSMS5dwa52')).toBe(false)
    })

    it('treats underscores and punctuation as token boundaries', () => {
      const regex = buildKeywordRegex('sms', { matchMode })
      expect(regex.test('sms_service')).toBe(true)
      expect(regex.test('sms-service')).toBe(true)
      expect(regex.test('smss')).toBe(false)
    })

    it('does not match inside non-ASCII words', () => {
      const regex = buildKeywordRegex('ana', { matchMode })
      expect(regex.test('ma帽ana')).toBe(false)
      expect(regex.test('ana')).toBe(true)
    })

    it('CJK terms degrade to substring in whole-word mode', () => {
      const regex = buildKeywordRegex('组合优于', { matchMode })
      expect(regex.test('投资组合优于其他策略')).toBe(true)
      expect(regex.test('组合优于')).toBe(true)
    })
  })

  describe('buildKeywordRegex (substring)', () => {
    const matchMode: KeywordMatchMode = 'substring'

    it('matches substrings inside other words', () => {
      const regex = buildKeywordRegex('sms', { matchMode })
      expect(regex.test('mechanisms')).toBe(true)
      expect(regex.test('IMr4WSMS5dwa52')).toBe(true)
    })
  })

  describe('buildKeywordUnionRegex', () => {
    it('builds a case-insensitive union regex', () => {
      const regex = buildKeywordUnionRegex(['sms', 'mms'], { matchMode: 'whole-word', flags: 'i' })
      expect(regex).not.toBeNull()
      expect(regex?.test('SMS')).toBe(true)
      expect(regex?.test('MMS')).toBe(true)
      expect(regex?.test('mechanisms')).toBe(false)
    })
  })
})
