import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { toAsarUnpackedPath } from '@main/utils'

const require_ = createRequire(import.meta.url)

export type ClaudeExecutablePlatform = 'win32' | 'darwin' | 'linux' | NodeJS.Platform
export type ClaudeExecutableArch = 'x64' | 'arm64' | NodeJS.Architecture

export type ClaudeExecutableResolverOptions = {
  platform?: ClaudeExecutablePlatform
  arch?: ClaudeExecutableArch
  existsSync?: (filePath: string) => boolean
  resolveModule?: (id: string) => string
  createRequireFromPath?: (filePath: string) => { resolve: (id: string) => string }
  searchRoots?: string[]
  toUnpackedPath?: (filePath: string) => string
}

export function getNativeClaudeExecutablePackageCandidates(
  options: Pick<ClaudeExecutableResolverOptions, 'platform' | 'arch'> = {}
): string[] {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const supportedArch = arch === 'x64' || arch === 'arm64' ? arch : null

  if (!supportedArch) {
    return []
  }

  if (platform === 'win32' || platform === 'darwin') {
    return [`@anthropic-ai/claude-agent-sdk-${platform}-${supportedArch}`]
  }

  if (platform === 'linux') {
    return [
      `@anthropic-ai/claude-agent-sdk-linux-${supportedArch}`,
      `@anthropic-ai/claude-agent-sdk-linux-${supportedArch}-musl`
    ]
  }

  return []
}

export function resolveClaudeExecutablePath(options: ClaudeExecutableResolverOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform
  const binaryName = platform === 'win32' ? 'claude.exe' : 'claude'
  const existsSync = options.existsSync ?? fs.existsSync
  const resolveModule = options.resolveModule ?? require_.resolve
  const toUnpackedPath = options.toUnpackedPath ?? toAsarUnpackedPath
  const existingExecutable = (candidate: string): string | undefined => {
    const unpacked = toUnpackedPath(candidate)
    return existsSync(unpacked) ? unpacked : undefined
  }

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  for (const root of options.searchRoots ?? (resourcesPath ? [resourcesPath] : [])) {
    const bundled = existingExecutable(
      path.join(root, 'claude-code', `${platform}-${options.arch ?? process.arch}`, binaryName)
    )
    if (bundled) return bundled
  }

  const resolvers = [resolveModule]
  try {
    const sdkRequire = (options.createRequireFromPath ?? createRequire)(resolveModule('@anthropic-ai/claude-agent-sdk'))
    resolvers.push((id) => sdkRequire.resolve(id))
  } catch {
    // A bundled copy can still be resolved from process.resourcesPath above.
  }

  for (const packageName of getNativeClaudeExecutablePackageCandidates(options)) {
    for (const resolve of resolvers) {
      try {
        const directPath = existingExecutable(resolve(`${packageName}/${binaryName}`))
        if (directPath) return directPath
      } catch {
        // Try package.json below; some packages may not expose the binary subpath.
      }

      try {
        const packageJsonPath = resolve(`${packageName}/package.json`)
        const candidate = path.join(path.dirname(packageJsonPath), binaryName)
        const executable = existingExecutable(candidate)
        if (executable) return executable
      } catch {
        // Optional native package is not installed for this platform.
      }
    }
  }

  try {
    const sdkDir = path.dirname(resolveModule('@anthropic-ai/claude-agent-sdk'))
    const legacyCliPath = path.join(sdkDir, 'cli.js')
    const executable = existingExecutable(legacyCliPath)
    if (executable) return executable
  } catch {
    // Let the SDK attempt auto-discovery when neither old nor new paths resolve.
  }

  return undefined
}
