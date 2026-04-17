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
    it('should return true for valid JSON string', () => {
      // 验证有效 JSON 字符�?      expect(isJSON('{"key": "value"}')).toBe(true)
    })

    it('should return false for empty string', () => {
      // 验证空字符串
      expect(isJSON('')).toBe(false)
    })

    it('should return false for invalid JSON string', () => {
      // 验证无效 JSON 字符�?      expect(isJSON('{invalid json}')).toBe(false)
    })

    it('should return false for non-string input', () => {
      // 验证非字符串输入
      expect(isJSON(123)).toBe(false)
      expect(isJSON({})).toBe(false)
      expect(isJSON(null)).toBe(false)
      expect(isJSON(undefined)).toBe(false)
    })
  })

  describe('parseJSON', () => {
    it('should parse valid JSON string to object', () => {
      // 验证有效 JSON 字符串解�?      const result = parseJSON('{"key": "value"}')
      expect(result).toEqual({ key: 'value' })
    })

    it('should return null for invalid JSON string', () => {
      // 验证无效 JSON 字符串返�?null
      const result = parseJSON('{invalid json}')
      expect(result).toBe(null)
    })
  })
})
