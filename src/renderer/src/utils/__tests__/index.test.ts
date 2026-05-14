import { describe, expect, it, vi } from 'vitest'

import { runAsyncFunction } from '../index'
import { hasPath, isValidProxyUrl, removeQuotes, removeSpecialCharacters } from '../index'

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      llm: {
        settings: {}
      }
    })
  }
}))

describe('Unclassified Utils', () => {
  describe('runAsyncFunction', () => {
    it('executes an async function', async () => {
      let called = false

      await runAsyncFunction(async () => {
        called = true
      })

      expect(called).toBe(true)
    })

    it('rethrows errors from the async function', async () => {
      await expect(
        runAsyncFunction(async () => {
          throw new Error('Test error')
        })
      ).rejects.toThrow('Test error')
    })
  })

  describe('removeQuotes', () => {
    it('removes single and double quotes', () => {
      expect(removeQuotes('"hello"')).toBe('hello')
      expect(removeQuotes("'hello'")).toBe('hello')
      expect(removeQuotes('noquotes')).toBe('noquotes')
    })

    it('handles an empty string', () => {
      expect(removeQuotes('')).toBe('')
    })

    it('handles strings containing only quotes', () => {
      expect(removeQuotes('""')).toBe('')
      expect(removeQuotes("''")).toBe('')
    })
  })

  describe('removeSpecialCharacters', () => {
    it('removes newlines, quotes, and punctuation', () => {
      expect(removeSpecialCharacters('hello\nworld!')).toBe('helloworld')
      expect(removeSpecialCharacters('"hello, world!"')).toBe('hello world')
      expect(removeSpecialCharacters('测试，内容！')).toBe('测试内容')
    })

    it('handles an empty string', () => {
      expect(removeSpecialCharacters('')).toBe('')
    })

    it('returns an empty string when the input is only special characters', () => {
      expect(removeSpecialCharacters('"\n!,.')).toBe('')
    })
  })

  describe('isValidProxyUrl', () => {
    it('returns true for strings containing a protocol separator', () => {
      expect(isValidProxyUrl('http://localhost')).toBe(true)
      expect(isValidProxyUrl('socks5://127.0.0.1:1080')).toBe(true)
    })

    it('returns false for strings without a protocol separator', () => {
      expect(isValidProxyUrl('localhost')).toBe(false)
      expect(isValidProxyUrl('127.0.0.1:1080')).toBe(false)
    })

    it('handles an empty string', () => {
      expect(isValidProxyUrl('')).toBe(false)
    })

    it('returns true for a bare protocol separator', () => {
      expect(isValidProxyUrl('://')).toBe(true)
    })
  })

  describe('hasPath', () => {
    it('returns true when a URL has a real path segment', () => {
      expect(hasPath('http://a.com/path')).toBe(true)
      expect(hasPath('http://a.com/path/to')).toBe(true)
    })

    it('returns false when a URL has no path or only root', () => {
      expect(hasPath('http://a.com/')).toBe(false)
      expect(hasPath('http://a.com')).toBe(false)
    })

    it('returns false for invalid URLs', () => {
      expect(hasPath('not a url')).toBe(false)
      expect(hasPath('')).toBe(false)
    })
  })
})
