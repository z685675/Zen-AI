import { describe, expect, it } from 'vitest'

import { formatFileSize, getFileDirectory, getFileExtension, removeSpecialCharactersForFileName } from '../file'

describe('file', () => {
  describe('getFileDirectory', () => {
    it('returns the directory path for a nested file path', () => {
      expect(getFileDirectory('path/to/file.txt')).toBe('path/to')
    })

    it('returns an empty string for files without a directory', () => {
      expect(getFileDirectory('file.txt')).toBe('')
    })

    it('handles absolute paths', () => {
      expect(getFileDirectory('/root/path/to/file.txt')).toBe('/root/path/to')
    })

    it('handles empty string input', () => {
      expect(getFileDirectory('')).toBe('')
    })
  })

  describe('getFileExtension', () => {
    it('returns a lowercase extension for a normal file', () => {
      expect(getFileExtension('document.pdf')).toBe('.pdf')
    })

    it('normalizes uppercase extensions to lowercase', () => {
      expect(getFileExtension('image.PNG')).toBe('.png')
    })

    it('returns only a dot when there is no extension', () => {
      expect(getFileExtension('noextension')).toBe('.')
    })

    it('handles hidden files with an extension', () => {
      expect(getFileExtension('.config.json')).toBe('.json')
    })

    it('handles empty string input', () => {
      expect(getFileExtension('')).toBe('.')
    })
  })

  describe('formatFileSize', () => {
    it('formats large sizes in MB', () => {
      expect(formatFileSize(1048576)).toBe('1.0 MB')
    })

    it('formats medium sizes in KB', () => {
      expect(formatFileSize(1024)).toBe('1 KB')
    })

    it('formats small sizes in KB with decimals', () => {
      expect(formatFileSize(500)).toBe('0.49 KB')
    })

    it('handles zero size', () => {
      expect(formatFileSize(0)).toBe('0.00 KB')
    })
  })

  describe('removeSpecialCharactersForFileName', () => {
    it('removes invalid filename characters', () => {
      expect(removeSpecialCharactersForFileName('Hello:<>World\nTest')).toBe('Hello___World Test')
    })

    it('returns the original string when nothing needs to be changed', () => {
      expect(removeSpecialCharactersForFileName('HelloWorld')).toBe('HelloWorld')
    })

    it('returns an empty string for empty input', () => {
      expect(removeSpecialCharactersForFileName('')).toBe('')
    })
  })
})
