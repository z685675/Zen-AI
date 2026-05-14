import path from 'path'
import { describe, expect, it } from 'vitest'

import { ensurePathWithin, validateArgs, validateCommand } from '../DxtService'

function stripDriveLetter(value: string) {
  return value.replace(/^[A-Z]:/i, '')
}

describe('ensurePathWithin', () => {
  const baseDir = path.join('/', 'home', 'user', 'mcp')

  it('accepts direct child paths', () => {
    const target1 = path.join('/', 'home', 'user', 'mcp', 'server-test')
    const target2 = path.join('/', 'home', 'user', 'mcp', 'server-hello')
    expect(stripDriveLetter(ensurePathWithin(baseDir, target1))).toBe(stripDriveLetter(path.resolve(target1)))
    expect(stripDriveLetter(ensurePathWithin(baseDir, target2))).toBe(stripDriveLetter(path.resolve(target2)))
  })

  it('accepts direct child paths with non-ASCII names', () => {
    const target1 = path.join('/', 'home', 'user', 'mcp', 'server-你好')
    const target2 = path.join('/', 'home', 'user', 'mcp', 'server-datos')
    expect(stripDriveLetter(ensurePathWithin(baseDir, target1))).toBe(stripDriveLetter(path.resolve(target1)))
    expect(stripDriveLetter(ensurePathWithin(baseDir, target2))).toBe(stripDriveLetter(path.resolve(target2)))
  })

  it('rejects paths that escape the base directory', () => {
    expect(() => ensurePathWithin(baseDir, path.join('/', 'home', 'user', 'mcp', '..', '..', '..', 'etc'))).toThrow(
      'Path traversal detected'
    )
    expect(() => ensurePathWithin(baseDir, '/etc/passwd')).toThrow('Path traversal detected')
    expect(() => ensurePathWithin(baseDir, '/home/user')).toThrow('Path traversal detected')
  })

  it('rejects nested subdirectories', () => {
    expect(() => ensurePathWithin(baseDir, path.join('/', 'home', 'user', 'mcp', 'sub', 'dir'))).toThrow(
      'Path traversal detected'
    )
  })

  it('rejects Windows-style path traversal', () => {
    const winBase = 'C:\\Users\\user\\mcp'
    expect(() => ensurePathWithin(winBase, 'C:\\Users\\user\\mcp\\..\\..\\Windows\\System32')).toThrow(
      'Path traversal detected'
    )
  })

  it('rejects null byte attacks', () => {
    const maliciousPath = path.join(baseDir, 'server\x00/../../../etc/passwd')
    expect(() => ensurePathWithin(baseDir, maliciousPath)).toThrow('Path traversal detected')
  })

  it('rejects the base directory itself', () => {
    expect(() => ensurePathWithin(baseDir, baseDir)).toThrow('Path traversal detected')
  })
})

describe('validateCommand', () => {
  it('accepts basic commands and trims whitespace', () => {
    expect(validateCommand('node')).toBe('node')
    expect(validateCommand('  python  ')).toBe('python')
    expect(validateCommand('/usr/bin/node')).toBe('/usr/bin/node')
    expect(validateCommand('./node_modules/.bin/tsc')).toBe('./node_modules/.bin/tsc')
  })

  it('rejects command path traversal', () => {
    expect(() => validateCommand('../../../bin/sh')).toThrow('path traversal detected')
    expect(() => validateCommand('..\\..\\Windows\\System32\\cmd.exe')).toThrow('path traversal detected')
    expect(() => validateCommand('..')).toThrow('path traversal detected')
  })

  it('rejects null bytes and empty input', () => {
    expect(() => validateCommand('node\x00.exe')).toThrow('null byte detected')
    expect(() => validateCommand('')).toThrow('command must be a non-empty string')
    expect(() => validateCommand('   ')).toThrow('command cannot be empty')
  })
})

describe('validateArgs', () => {
  it('accepts ordinary arguments', () => {
    expect(validateArgs(['--version'])).toEqual(['--version'])
    expect(validateArgs(['./src/index.ts'])).toEqual(['./src/index.ts'])
    expect(validateArgs([])).toEqual([])
  })

  it('rejects path traversal arguments', () => {
    expect(() => validateArgs(['../../../etc/passwd'])).toThrow('path traversal detected')
    expect(() => validateArgs(['..\\..\\Windows\\System32\\config'])).toThrow('path traversal detected')
  })

  it('rejects null bytes and non-array input', () => {
    expect(() => validateArgs(['file\x00.txt'])).toThrow('null byte detected')
    expect(() => validateArgs('not an array' as unknown as string[])).toThrow('must be an array')
  })

  it('rejects non-string elements', () => {
    expect(() => validateArgs([123 as unknown as string])).toThrow('must be a string')
  })
})
