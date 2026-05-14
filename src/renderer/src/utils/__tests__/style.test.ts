import { describe, expect, it } from 'vitest'

import { classNames, generateColorFromChar } from '../style'

describe('style', () => {
  describe('classNames', () => {
    it('handles string arguments', () => {
      expect(classNames('foo', 'bar')).toBe('foo bar')
      expect(classNames('foo bar', 'baz')).toBe('foo bar baz')
      expect(classNames('foo', '')).toBe('foo')
    })

    it('handles number arguments', () => {
      expect(classNames(1, 2)).toBe('1 2')
      expect(classNames('foo', 123)).toBe('foo 123')
    })

    it('filters out falsy primitive values', () => {
      expect(classNames('foo', null, 'bar')).toBe('foo bar')
      expect(classNames('foo', undefined, 'bar')).toBe('foo bar')
      expect(classNames('foo', false, 'bar')).toBe('foo bar')
      expect(classNames('foo', true, 'bar')).toBe('foo bar')
      expect(classNames('foo', 0, 'bar')).toBe('foo bar')
    })

    it('handles object arguments', () => {
      expect(classNames({ foo: true, bar: false })).toBe('foo')
      expect(classNames({ foo: true, bar: true })).toBe('foo bar')
      expect(classNames({ 'foo-bar': true })).toBe('foo-bar')
      expect(classNames({ foo: 1, bar: 0 })).toBe('foo')
      expect(classNames({ foo: {}, bar: [] })).toBe('foo bar')
      expect(classNames({ foo: '', bar: null })).toBe('')
    })

    it('handles array arguments', () => {
      expect(classNames(['foo', 'bar'])).toBe('foo bar')
      expect(classNames(['foo'], ['bar'])).toBe('foo bar')
      expect(classNames(['foo', null])).toBe('foo')
    })

    it('handles nested arrays', () => {
      expect(classNames(['foo', ['bar', 'baz']])).toBe('foo bar baz')
      expect(classNames(['foo', ['bar', ['baz', 'qux']]])).toBe('foo bar baz qux')
    })

    it('handles mixed argument types', () => {
      expect(classNames('foo', { bar: true, baz: false }, ['qux'])).toBe('foo bar qux')
      expect(classNames('a', ['b', { c: true, d: false }], 'e')).toBe('a b c e')
    })

    it('handles complex combinations', () => {
      expect(
        classNames(
          'btn',
          {
            'btn-primary': true,
            'btn-large': false,
            'btn-disabled': null,
            'btn-active': 1
          },
          ['btn-block', ['btn-responsive', { 'btn-focus': true }]]
        )
      ).toBe('btn btn-primary btn-active btn-block btn-responsive btn-focus')
    })

    it('handles empty arguments', () => {
      expect(classNames()).toBe('')
      expect(classNames(null, undefined, false, '')).toBe('')
      expect(classNames({})).toBe('')
      expect(classNames([])).toBe('')
    })

    it('filters out empty strings after processing', () => {
      expect(classNames({ '': true })).toBe('')
      expect(classNames([''])).toBe('')
      expect(classNames('foo', '', 'bar')).toBe('foo bar')
    })
  })

  describe('generateColorFromChar', () => {
    it('generates a valid hex color code', () => {
      expect(generateColorFromChar('A')).toMatch(/^#[0-9a-fA-F]{6}$/)
    })

    it('returns a stable color for the same input', () => {
      expect(generateColorFromChar('A')).toBe(generateColorFromChar('A'))
    })

    it('returns different colors for different inputs', () => {
      expect(generateColorFromChar('A')).not.toBe(generateColorFromChar('B'))
    })
  })
})
