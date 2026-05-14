import { describe, expect, it, vi } from 'vitest'

import { isJSON, parseJSON } from '../index'

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      llm: {
        settings: {}
      }
    })
  }
}))

describe('json', () => {
  describe('isJSON', () => {
    it('returns true for a valid JSON string', () => {
      expect(isJSON('{"key": "value"}')).toBe(true)
    })

    it('returns false for an empty string', () => {
      expect(isJSON('')).toBe(false)
    })

    it('returns false for an invalid JSON string', () => {
      expect(isJSON('{invalid json}')).toBe(false)
    })

    it('returns false for non-string input', () => {
      expect(isJSON(123)).toBe(false)
      expect(isJSON({})).toBe(false)
      expect(isJSON(null)).toBe(false)
      expect(isJSON(undefined)).toBe(false)
    })
  })

  describe('parseJSON', () => {
    it('parses a valid JSON string into an object', () => {
      expect(parseJSON('{"key": "value"}')).toEqual({ key: 'value' })
    })

    it('returns null for an invalid JSON string', () => {
      expect(parseJSON('{invalid json}')).toBe(null)
    })
  })
})
