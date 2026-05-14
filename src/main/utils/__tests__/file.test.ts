import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { FILE_TYPE } from '@types'
import chardet from 'chardet'
import iconv from 'iconv-lite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getAllFiles,
  getAppConfigDir,
  getConfigDir,
  getFilesDir,
  getFileType,
  getTempDir,
  isPathInside,
  readTextFileWithAutoEncoding,
  resolveAndValidatePath,
  untildify
} from '../file'

vi.mock('node:fs')
vi.mock('node:fs/promises')
vi.mock('node:os')
vi.mock('node:path')
vi.mock('uuid', () => ({
  v4: () => 'mock-uuid'
}))
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key) => {
      if (key === 'temp') return '/mock/temp'
      if (key === 'userData') return '/mock/userData'
      return '/mock/unknown'
    })
  }
}))

describe('file utils', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    Object.defineProperty(path, 'sep', { value: '/', configurable: true })

    vi.mocked(path.extname).mockImplementation((file) => {
      const parts = String(file).split('.')
      return parts.length > 1 ? `.${parts[parts.length - 1]}` : ''
    })
    vi.mocked(path.basename).mockImplementation((file) => {
      const parts = String(file).split(/[\\/]/)
      return parts[parts.length - 1]
    })
    vi.mocked(path.dirname).mockImplementation((file) => {
      const parts = String(file).split('/')
      return parts.slice(0, -1).join('/') || '/'
    })
    vi.mocked(path.join).mockImplementation((...args) => args.join('/'))
    vi.mocked(path.resolve).mockImplementation((...args) => {
      const joined = args.filter(Boolean).join('/').replace(/\/+/g, '/')
      return joined.startsWith('/') ? joined : `/${joined}`
    })
    vi.mocked(path.normalize).mockImplementation((p) => String(p).replace(/\/+/g, '/'))
    vi.mocked(path.relative).mockImplementation((from, to) => {
      const fromNorm = String(from).replace(/\/+/g, '/')
      const toNorm = String(to).replace(/\/+/g, '/')
      if (toNorm === fromNorm) return ''
      if (toNorm.startsWith(`${fromNorm}/`)) return toNorm.slice(fromNorm.length + 1)
      return `../${toNorm.split('/').pop() ?? ''}`
    })
    vi.mocked(path.isAbsolute).mockImplementation((p) => String(p).startsWith('/'))
    vi.mocked(os.homedir).mockReturnValue('/mock/home')
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('getFileType', () => {
    it('classifies common file extensions', () => {
      expect(getFileType('.jpg')).toBe(FILE_TYPE.IMAGE)
      expect(getFileType('.mp4')).toBe(FILE_TYPE.VIDEO)
      expect(getFileType('.mp3')).toBe(FILE_TYPE.AUDIO)
      expect(getFileType('.txt')).toBe(FILE_TYPE.TEXT)
      expect(getFileType('.pdf')).toBe(FILE_TYPE.DOCUMENT)
      expect(getFileType('.unknown')).toBe(FILE_TYPE.OTHER)
    })

    it('is case-insensitive', () => {
      expect(getFileType('.JPG')).toBe(FILE_TYPE.IMAGE)
      expect(getFileType('.PDF')).toBe(FILE_TYPE.DOCUMENT)
    })
  })

  describe('getAllFiles', () => {
    it('returns supported files recursively', () => {
      vi.spyOn(fs, 'readdirSync').mockImplementation((dirPath) => {
        if (dirPath === '/test') return ['file1.txt', 'file2.pdf', 'subdir']
        if (dirPath === '/test/subdir') return ['file3.md', 'file4.docx']
        return []
      })

      vi.mocked(fs.statSync).mockImplementation((filePath) => {
        const isDir = String(filePath).endsWith('subdir')
        return {
          isDirectory: () => isDir,
          size: 1024
        } as fs.Stats
      })

      const result = getAllFiles('/test')
      expect(result).toHaveLength(4)
      expect(result[0].id).toBe('mock-uuid')
      expect(result[0].name).toBe('file1.txt')
      expect(result[1].type).toBe(FILE_TYPE.DOCUMENT)
    })

    it('skips hidden and unsupported files', () => {
      vi.spyOn(fs, 'readdirSync').mockReturnValue(['.hidden', 'image.jpg', 'document.pdf'] as never)
      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => false,
        size: 1024
      } as fs.Stats)

      const result = getAllFiles('/test')
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('document.pdf')
    })
  })

  describe('directory helpers', () => {
    it('returns current app temp and data directories', () => {
      expect(getTempDir()).toBe('/mock/temp/ZenAI')
      expect(getFilesDir()).toBe('/mock/userData/Data/Files')
    })

    it('returns config directories', () => {
      expect(getConfigDir()).toBe('/mock/home/.zen-ai/config')
      expect(getAppConfigDir('test-app')).toBe('/mock/home/.zen-ai/config/test-app')
    })
  })

  describe('readTextFileWithAutoEncoding', () => {
    const mockFilePath = '/path/to/mock/file.txt'

    it('reads GB18030 content', async () => {
      const content = '这是一个 GB18030 编码的测试内容'
      const buffer = Buffer.from(iconv.encode(content, 'GB18030'))

      vi.spyOn(fsPromises, 'readFile').mockResolvedValue(buffer)
      vi.spyOn(chardet, 'detectFile').mockResolvedValue('GB18030')

      await expect(readTextFileWithAutoEncoding(mockFilePath)).resolves.toBe(content)
    })

    it('falls back to UTF-8 when detection is wrong', async () => {
      const content = '这是一个 UTF-8 编码的测试内容'
      const buffer = Buffer.from(iconv.encode(content, 'UTF-8'))

      vi.spyOn(fsPromises, 'readFile').mockResolvedValue(buffer)
      vi.spyOn(chardet, 'detectFile').mockResolvedValue('GB18030')

      await expect(readTextFileWithAutoEncoding(mockFilePath)).resolves.toBe(content)
    })
  })

  describe('untildify', () => {
    it('expands leading tilde only', () => {
      expect(untildify('~')).toBe('/mock/home')
      expect(untildify('~/Documents')).toBe('/mock/home/Documents')
      expect(untildify('~\\Documents')).toBe('/mock/home\\Documents')
      expect(untildify('folder/~/file')).toBe('folder/~/file')
      expect(untildify('~user')).toBe('~user')
    })

    it('handles spaces and non-ASCII paths', () => {
      expect(untildify('~/项目')).toBe('/mock/home/项目')
      expect(untildify('~/folder with spaces')).toBe('/mock/home/folder with spaces')
    })
  })

  describe('isPathInside', () => {
    it('distinguishes true descendants from similar prefixes', () => {
      expect(isPathInside('/root/test/child', '/root/test')).toBe(true)
      expect(isPathInside('/root/test aaa', '/root/test')).toBe(false)
      expect(isPathInside('/home/user-data', '/home/user')).toBe(false)
      expect(isPathInside('/root/test', '/root/test')).toBe(true)
    })

    it('returns false if path helpers throw', () => {
      vi.mocked(path.resolve).mockImplementation(() => {
        throw new Error('Path resolution failed')
      })
      expect(isPathInside('/any/path', '/any/parent')).toBe(false)
    })
  })

  describe('resolveAndValidatePath', () => {
    it('resolves valid relative paths', () => {
      expect(resolveAndValidatePath('/base', 'file.txt')).toBe('/base/file.txt')
      expect(resolveAndValidatePath('/base', 'subdir/file.txt')).toBe('/base/subdir/file.txt')
    })

    it('rejects path traversal and base directory itself', () => {
      vi.mocked(path.resolve).mockImplementation((...args) => {
        const rawParts = args
          .filter((value) => value !== undefined && value !== null)
          .flatMap((value) => String(value).split('/'))
          .filter(Boolean)

        const resolved: string[] = []
        for (const part of rawParts) {
          if (part === '..') {
            resolved.pop()
          } else if (part !== '.') {
            resolved.push(part)
          }
        }

        return `/${resolved.join('/')}`
      })

      expect(() => resolveAndValidatePath('/base/dir', '../etc/passwd')).toThrow(
        'Invalid file path: path traversal detected'
      )
      expect(() => resolveAndValidatePath('/base/dir', '')).toThrow('Invalid file path: path traversal detected')
    })
  })
})
