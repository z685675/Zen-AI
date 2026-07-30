import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { getCodexTarget, resolveCodexExecutable, resolveCodexExecutablePath } from '../executable'

describe('Codex executable resolver', () => {
  it('maps supported platforms to the matching native Codex package', () => {
    expect(getCodexTarget({ platform: 'win32', arch: 'x64' })).toEqual({
      targetTriple: 'x86_64-pc-windows-msvc',
      packageName: '@openai/codex-win32-x64'
    })
    expect(getCodexTarget({ platform: 'darwin', arch: 'arm64' })).toEqual({
      targetTriple: 'aarch64-apple-darwin',
      packageName: '@openai/codex-darwin-arm64'
    })
    expect(getCodexTarget({ platform: 'linux', arch: 'x64' })).toEqual({
      targetTriple: 'x86_64-unknown-linux-musl',
      packageName: '@openai/codex-linux-x64'
    })
  })

  it('resolves pnpm nested native package binaries through @openai/codex', () => {
    const codexPackageJson = path.join('repo', 'node_modules', '@openai', 'codex', 'package.json')
    const nativePackageJson = path.join(
      'repo',
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'package.json'
    )
    const nativeRoot = path.dirname(nativePackageJson)
    const targetRoot = path.join(nativeRoot, 'vendor', 'x86_64-pc-windows-msvc')
    const binaryPath = path.join(targetRoot, 'bin', 'codex.exe')
    const pathDir = path.join(targetRoot, 'codex-path')
    const files = new Set([binaryPath, path.join(targetRoot, 'codex-package.json'), pathDir])

    const resolved = resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      existsSync: (filePath) => files.has(filePath),
      isFile: (filePath) => files.has(filePath) && filePath !== pathDir,
      resolveModule: (id) => {
        if (id === '@openai/codex/package.json') {
          return codexPackageJson
        }
        throw new Error(`Cannot resolve ${id}`)
      },
      createRequireFromPath: () => ({
        resolve: (id: string) => {
          if (id === '@openai/codex-win32-x64/package.json') {
            return nativePackageJson
          }
          throw new Error(`Cannot resolve ${id}`)
        }
      }),
      toUnpackedPath: (filePath) => filePath.replace('app.asar', 'app.asar.unpacked')
    })

    expect(resolved).toEqual({
      executablePath: binaryPath,
      pathDirs: [pathDir]
    })
  })

  it('falls back to the Codex SDK entrypoint when app-level module resolution cannot see nested packages', () => {
    const sdkEntry = path.resolve('repo', 'node_modules', '@openai', 'codex-sdk', 'dist', 'index.js')
    const codexPackageJson = path.resolve('repo', 'node_modules', '@openai', 'codex', 'package.json')
    const nativePackageJson = path.resolve('repo', 'node_modules', '@openai', 'codex-win32-x64', 'package.json')
    const nativeRoot = path.dirname(nativePackageJson)
    const targetRoot = path.join(nativeRoot, 'vendor', 'x86_64-pc-windows-msvc')
    const binaryPath = path.join(targetRoot, 'bin', 'codex.exe')
    const files = new Set([binaryPath, path.join(targetRoot, 'codex-package.json')])

    const resolved = resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      existsSync: (filePath) => files.has(filePath),
      isFile: (filePath) => files.has(filePath),
      resolveModule: (id) => {
        if (id === '@openai/codex-sdk') {
          return sdkEntry
        }
        throw new Error(`Cannot resolve ${id}`)
      },
      createRequireFromPath: (filePath) => ({
        resolve: (id: string) => {
          if (filePath === sdkEntry && id === '@openai/codex/package.json') {
            return codexPackageJson
          }
          if (filePath === codexPackageJson && id === '@openai/codex-win32-x64/package.json') {
            return nativePackageJson
          }
          throw new Error(`Cannot resolve ${id}`)
        }
      })
    })

    expect(resolved?.executablePath).toBe(binaryPath)
  })

  it('scans pnpm node_modules when bundled Electron module resolution cannot see Codex packages', () => {
    const root = path.resolve('repo')
    const pnpmEntry = '@openai+codex@0.142.5-win32-x64'
    const packageJsonPath = path.join(
      root,
      'node_modules',
      '.pnpm',
      pnpmEntry,
      'node_modules',
      '@openai',
      'codex',
      'package.json'
    )
    const targetRoot = path.join(path.dirname(packageJsonPath), 'vendor', 'x86_64-pc-windows-msvc')
    const binaryPath = path.join(targetRoot, 'bin', 'codex.exe')
    const files = new Set([
      path.join(root, 'node_modules', '.pnpm'),
      packageJsonPath,
      binaryPath,
      path.join(targetRoot, 'codex-package.json')
    ])

    const resolved = resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      searchRoots: [root],
      existsSync: (filePath) => files.has(filePath),
      isFile: (filePath) => filePath !== path.join(root, 'node_modules', '.pnpm') && files.has(filePath),
      readDirSync: (dirPath) => (dirPath === path.join(root, 'node_modules', '.pnpm') ? [pnpmEntry] : []),
      resolveModule: (id) => {
        throw new Error(`Cannot resolve ${id}`)
      }
    })

    expect(resolved?.executablePath).toBe(binaryPath)
  })

  it('resolves a Codex runtime copied into packaged application resources', () => {
    const resourcesRoot = path.resolve('app', 'resources')
    const targetRoot = path.join(resourcesRoot, 'codex', 'vendor', 'x86_64-pc-windows-msvc')
    const binaryPath = path.join(targetRoot, 'bin', 'codex.exe')
    const pathDir = path.join(targetRoot, 'codex-path')
    const files = new Set([binaryPath, path.join(targetRoot, 'codex-package.json'), pathDir])

    const resolved = resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      searchRoots: [resourcesRoot],
      existsSync: (filePath) => files.has(filePath),
      isFile: (filePath) => filePath !== pathDir && files.has(filePath),
      resolveModule: (id) => {
        throw new Error(`Cannot resolve ${id}`)
      }
    })

    expect(resolved).toEqual({
      executablePath: binaryPath,
      pathDirs: [pathDir]
    })
  })

  it('returns undefined when the platform is unsupported', () => {
    expect(resolveCodexExecutablePath({ platform: 'freebsd', arch: 'x64' })).toBeUndefined()
  })
})
