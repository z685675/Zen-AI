import { describe, expect, it } from 'vitest'

import { getNativeClaudeExecutablePackageCandidates, resolveClaudeExecutablePath } from '../executable'

const normalizePath = (filePath: string | undefined) => filePath?.replace(/\\/g, '/')

describe('getNativeClaudeExecutablePackageCandidates', () => {
  it('returns Windows package for supported Windows architectures', () => {
    expect(getNativeClaudeExecutablePackageCandidates({ platform: 'win32', arch: 'x64' })).toEqual([
      '@anthropic-ai/claude-agent-sdk-win32-x64'
    ])
  })

  it('returns glibc and musl Linux packages for supported Linux architectures', () => {
    expect(getNativeClaudeExecutablePackageCandidates({ platform: 'linux', arch: 'arm64' })).toEqual([
      '@anthropic-ai/claude-agent-sdk-linux-arm64',
      '@anthropic-ai/claude-agent-sdk-linux-arm64-musl'
    ])
  })

  it('returns no native package candidates for unsupported architectures', () => {
    expect(getNativeClaudeExecutablePackageCandidates({ platform: 'win32', arch: 'ia32' })).toEqual([])
  })
})

describe('resolveClaudeExecutablePath', () => {
  it('prefers the direct native binary subpath used by Claude Agent SDK 0.3+', () => {
    const resolved = resolveClaudeExecutablePath({
      platform: 'win32',
      arch: 'x64',
      resolveModule: (id) => {
        if (id === '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe') {
          return 'C:\\app\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe'
        }
        throw new Error(`Missing module: ${id}`)
      },
      existsSync: () => false,
      toUnpackedPath: (filePath) => `${filePath}.unpacked`
    })

    expect(resolved).toBe('C:\\app\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe.unpacked')
  })

  it('falls back to native package directory when the binary subpath is not exported', () => {
    const existing = new Set(['/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'])
    const resolved = resolveClaudeExecutablePath({
      platform: 'darwin',
      arch: 'arm64',
      resolveModule: (id) => {
        if (id === '@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json') {
          return '/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json'
        }
        throw new Error(`Missing module: ${id}`)
      },
      existsSync: (filePath) => existing.has(normalizePath(filePath) ?? ''),
      toUnpackedPath: (filePath) => filePath
    })

    expect(normalizePath(resolved)).toBe('/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
  })

  it('falls back to legacy cli.js used by Claude Agent SDK 0.2.x', () => {
    const existing = new Set(['/app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js'])
    const resolved = resolveClaudeExecutablePath({
      platform: 'linux',
      arch: 'x64',
      resolveModule: (id) => {
        if (id === '@anthropic-ai/claude-agent-sdk') {
          return '/app/node_modules/@anthropic-ai/claude-agent-sdk/index.js'
        }
        throw new Error(`Missing module: ${id}`)
      },
      existsSync: (filePath) => existing.has(normalizePath(filePath) ?? ''),
      toUnpackedPath: (filePath) => filePath
    })

    expect(normalizePath(resolved)).toBe('/app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js')
  })

  it('returns undefined when no known executable path can be resolved', () => {
    const resolved = resolveClaudeExecutablePath({
      platform: 'linux',
      arch: 'x64',
      resolveModule: (id) => {
        throw new Error(`Missing module: ${id}`)
      },
      existsSync: () => false
    })

    expect(resolved).toBeUndefined()
  })
})
