import { sortedObjectByKeys } from '../sort'

describe('sortedObjectByKeys', () => {
  test('should sort keys of a flat object alphabetically', () => {
    const obj = { b: 2, a: 1, c: 3 }
    const sortedObj = { a: 1, b: 2, c: 3 }
    expect(sortedObjectByKeys(obj)).toEqual(sortedObj)
  })

  test('should sort keys of nested objects alphabetically', () => {
    const obj = {
      c: { z: 3, y: 2, x: 1 },
      a: 1,
      b: { f: 6, d: 4, e: 5 }
    }
    const sortedObj = {
      a: 1,
      b: { d: 4, e: 5, f: 6 },
      c: { x: 1, y: 2, z: 3 }
    }
    expect(sortedObjectByKeys(obj)).toEqual(sortedObj)
  })

  test('should handle empty objects', () => {
    const obj = {}
    expect(sortedObjectByKeys(obj)).toEqual({})
  })

  test('should handle objects with non-object values', () => {
    const obj = { b: 'hello', a: 123, c: true }
    const sortedObj = { a: 123, b: 'hello', c: true }
    expect(sortedObjectByKeys(obj)).toEqual(sortedObj)
  })

  test('should handle objects with array values', () => {
    const obj = { b: [2, 1], a: [1, 2] }
    const sortedObj = { a: [1, 2], b: [2, 1] }
    expect(sortedObjectByKeys(obj)).toEqual(sortedObj)
  })

  test('should handle objects with null values', () => {
    const obj = { b: null, a: 1 }
    const sortedObj = { a: 1, b: null }
    expect(sortedObjectByKeys(obj)).toEqual(sortedObj)
  })

  test('should handle objects with undefined values', () => {
    const obj = { b: undefined, a: 1 }
    const sortedObj = { a: 1, b: undefined }
    expect(sortedObjectByKeys(obj)).toEqual(sortedObj)
  })

  test('should not modify the original object', () => {
    const obj = { b: 2, a: 1 }
    sortedObjectByKeys(obj)
    expect(obj).toEqual({ b: 2, a: 1 })
  })

  test('should handle objects read from i18n JSON files', () => {
    const obj = {
      translation: {
        backup: {
          progress: {
            writing_data: '\u5199\u5165\u6570\u636e...',
            preparing: '\u6b63\u5728\u51c6\u5907...',
            completed: '\u5df2\u5b8c\u6210'
          }
        },
        agents: {
          'delete.popup.content': '\u786e\u5b9a\u8981\u5220\u9664\u8be5\u667a\u80fd\u4f53\u5417\uff1f',
          'edit.model.select.title': '\u9009\u62e9\u6a21\u578b'
        }
      }
    }
    const sortedObj = {
      translation: {
        agents: {
          'delete.popup.content': '\u786e\u5b9a\u8981\u5220\u9664\u8be5\u667a\u80fd\u4f53\u5417\uff1f',
          'edit.model.select.title': '\u9009\u62e9\u6a21\u578b'
        },
        backup: {
          progress: {
            completed: '\u5df2\u5b8c\u6210',
            preparing: '\u6b63\u5728\u51c6\u5907...',
            writing_data: '\u5199\u5165\u6570\u636e...'
          }
        }
      }
    }
    expect(sortedObjectByKeys(obj)).toEqual(sortedObj)
  })
})
