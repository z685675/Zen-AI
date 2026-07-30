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

  for (const packageName of getNativeClaudeExecutablePackageCandidates(options)) {
    try {
      const directPath = resolveModule(`${packageName}/${binaryName}`)
      return toUnpackedPath(directPath)
    } catch {
      // Try package.json below; some packages may not expose the binary subpath.
    }

    try {
      const packageJsonPath = resolveModule(`${packageName}/package.json`)
      const candidate = path.join(path.dirname(packageJsonPath), binaryName)
      if (existsSync(candidate)) {
        return toUnpackedPath(candidate)
      }
    } catch {
      // Optional native package is not installed for this platform.
    }
  }

  try {
    const sdkDir = path.dirname(resolveModule('@anthropic-ai/claude-agent-sdk'))
    const legacyCliPath = path.join(sdkDir, 'cli.js')
    if (existsSync(legacyCliPath)) {
      return toUnpackedPath(legacyCliPath)
    }
  } catch {
    // Let the SDK attempt auto-discovery when neither old nor new paths resolve.
  }

  return undefined
}
