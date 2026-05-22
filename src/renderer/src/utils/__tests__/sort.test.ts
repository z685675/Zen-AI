import { describe, expect, it } from 'vitest'

import { droppableReorder, sortByEnglishFirst } from '../sort'

describe('sort', () => {
  describe('droppableReorder', () => {
    it('reorders a single element forward', () => {
      expect(droppableReorder([1, 2, 3, 4, 5], 0, 2)).toEqual([2, 3, 1, 4, 5])
    })

    it('reorders a single element backward', () => {
      expect(droppableReorder([1, 2, 3, 4, 5], 4, 1)).toEqual([1, 5, 2, 3, 4])
    })

    it('preserves multi-element group order', () => {
      expect(droppableReorder([1, 2, 3, 4, 5], 1, 3, 2)).toEqual([1, 4, 2, 3, 5])
      expect(droppableReorder([1, 2, 3, 4, 5, 6, 7], 4, 1, 3)).toEqual([1, 5, 6, 7, 2, 3, 4])
    })

    it('does not mutate the original list', () => {
      const list = [1, 2, 3, 4, 5]
      const original = [...list]
      droppableReorder(list, 0, 2)
      expect(list).toEqual(original)
    })

    it('works with strings and objects', () => {
      expect(droppableReorder(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
      expect(droppableReorder([{ id: 1 }, { id: 2 }, { id: 3 }], 0, 2)).toEqual([{ id: 2 }, { id: 3 }, { id: 1 }])
    })
  })

  describe('sortByEnglishFirst', () => {
    it('puts English-leading strings before non-English-leading strings', () => {
      expect(sortByEnglishFirst('apple', '苹果')).toBe(-1)
      expect(sortByEnglishFirst('苹果', 'apple')).toBe(1)
    })

    it('uses locale comparison when both strings are in the same category', () => {
      expect(sortByEnglishFirst('banana', 'apple')).toBeGreaterThan(0)
      expect(typeof sortByEnglishFirst('苹果', '香蕉')).toBe('number')
    })

    it('treats empty, numeric, and special-character prefixes as non-English-leading', () => {
      expect(sortByEnglishFirst('', 'a')).toBeGreaterThan(0)
      expect(sortByEnglishFirst('a', '')).toBeLessThan(0)
      expect(sortByEnglishFirst('1apple', 'apple')).toBeGreaterThan(0)
      expect(sortByEnglishFirst('#apple', 'banana')).toBeGreaterThan(0)
    })
  })
})
