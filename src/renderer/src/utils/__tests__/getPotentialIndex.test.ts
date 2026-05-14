import { describe, expect, it } from 'vitest'

import { getPotentialStartIndex } from '../getPotentialIndex'

describe('getPotentialStartIndex', () => {
  it('returns the direct match index', () => {
    expect(getPotentialStartIndex('Hello world', 'world')).toBe(6)
  })

  it('returns the suffix start when the text ends with a partial match', () => {
    expect(getPotentialStartIndex('Hello wo', 'world')).toBe(6)
    expect(getPotentialStartIndex('Response with <thin', '<thinking>')).toBe(14)
  })

  it('returns null for empty searched text or unrelated text', () => {
    expect(getPotentialStartIndex('Hello', '')).toBeNull()
    expect(getPotentialStartIndex('Hello', 'abc')).toBeNull()
  })

  it('works with special characters and multibyte text', () => {
    expect(getPotentialStartIndex('Hello\n', '\nworld')).toBe(5)
    expect(getPotentialStartIndex('Test 中文', '中文内容')).toBe(5)
  })
})
