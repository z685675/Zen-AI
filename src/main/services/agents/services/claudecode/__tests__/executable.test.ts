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
      existsSync: (filePath) => filePath.endsWith('claude.exe.unpacked'),
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

  it.each([
    ['darwin', 'arm64', 'claude'],
    ['darwin', 'x64', 'claude'],
    ['win32', 'arm64', 'claude.exe'],
    ['win32', 'x64', 'claude.exe']
  ] as const)(
    'resolves the standalone packaged runtime on %s/%s without optional module resolution',
    (platform, arch, binary) => {
      const resources = '/packaged/Contents/Resources'
      const expected = `${resources}/claude-code/${platform}-${arch}/${binary}`
      const resolved = resolveClaudeExecutablePath({
        platform,
        arch,
        searchRoots: [resources],
        existsSync: (filePath) => normalizePath(filePath) === expected,
        resolveModule: () => {
          throw new Error('Optional dependencies not visible from bundled main process')
        },
        toUnpackedPath: (filePath) => filePath
      })
      expect(normalizePath(resolved)).toBe(expected)
    }
  )

  it('resolves optional native dependencies relative to the SDK in pnpm', () => {
    const nativePath = '/repo/node_modules/.pnpm/native/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    const sdkPath = '/repo/node_modules/.pnpm/sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
    const resolved = resolveClaudeExecutablePath({
      platform: 'darwin',
      arch: 'arm64',
      searchRoots: [],
      resolveModule: (id) => {
        if (id === '@anthropic-ai/claude-agent-sdk') return sdkPath
        throw new Error('Native module is not hoisted')
      },
      createRequireFromPath: (filePath) => {
        expect(filePath).toBe(sdkPath)
        return { resolve: () => nativePath }
      },
      existsSync: (filePath) => filePath === nativePath,
      toUnpackedPath: (filePath) => filePath
    })
    expect(resolved).toBe(nativePath)
  })

  it('rejects a binary visible in asar when its unpacked executable is missing', () => {
    const resolved = resolveClaudeExecutablePath({
      platform: 'darwin',
      arch: 'arm64',
      searchRoots: [],
      resolveModule: (id) => {
        if (id.endsWith('/claude')) return '/app/app.asar/node_modules/native/claude'
        throw new Error('Not found')
      },
      existsSync: (filePath) => filePath.includes('app.asar/'),
      toUnpackedPath: (filePath) => filePath.replace('app.asar/', 'app.asar.unpacked/')
    })
    expect(resolved).toBeUndefined()
  })
})
