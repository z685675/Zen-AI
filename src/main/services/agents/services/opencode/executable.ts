import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { toAsarUnpackedPath } from '@main/utils'
import { app } from 'electron'

import { diagnosticText } from '../../../../../../packages/shared/diagnostics'
import { OPENCODE_VERSION } from './config'

const packagedExecutable = (platform: NodeJS.Platform, arch: string) =>
  path.join(
    process.resourcesPath,
    'opencode',
    `${platform === 'win32' ? 'windows' : platform}-${arch}`,
    platform === 'win32' ? 'opencode.exe' : 'opencode'
  )

export function resolveOpenCodeExecutable(platform = process.platform, arch = process.arch): string {
  if (app.isPackaged) {
    const packaged = packagedExecutable(platform, arch)
    if (!existsSync(packaged))
      throw new Error(`OpenCode ${OPENCODE_VERSION} is missing from the installer; reinstall Zen AI`)
    return packaged
  }
  const runtimeRequire = createRequire(path.join(app.getAppPath(), 'package.json'))
  const packageRequire = createRequire(runtimeRequire.resolve('opencode-ai/package.json'))
  const os = platform === 'win32' ? 'windows' : platform
  const packages =
    arch === 'x64' ? [`opencode-${os}-${arch}-baseline`, `opencode-${os}-${arch}`] : [`opencode-${os}-${arch}`]
  for (const name of packages) {
    try {
      const manifest = packageRequire.resolve(`${name}/package.json`)
      return toAsarUnpackedPath(
        path.join(path.dirname(manifest), 'bin', platform === 'win32' ? 'opencode.exe' : 'opencode')
      )
    } catch {
      /* Next supported CPU package. */
    }
  }
  throw new Error(`OpenCode ${OPENCODE_VERSION} runtime missing for ${platform}-${arch}; reinstall Zen AI`)
}

/** Inspect the same resolver used to launch; never launch, repair or download a runtime. */
export function inspectOpenCodeExecutable(platform = process.platform, arch = process.arch) {
  const info = {
    expectedVersion: OPENCODE_VERSION,
    platform,
    arch,
    packaged: app.isPackaged,
    snapshotTime: 'export-time',
    resolutionStatus: 'unavailable',
    path: undefined as string | undefined,
    exists: undefined as boolean | undefined,
    isFile: undefined as boolean | undefined,
    sizeBytes: undefined as number | undefined,
    executablePermission: platform === 'win32' ? 'not-applicable-on-windows' : ('not-checked' as string | boolean),
    error: undefined as string | undefined
  }
  try {
    if (app.isPackaged) {
      info.path = packagedExecutable(platform, arch)
      info.exists = existsSync(info.path)
    }
    info.path = resolveOpenCodeExecutable(platform, arch)
    info.resolutionStatus = 'resolved'
    info.exists = existsSync(info.path)
    if (info.exists) {
      const stat = statSync(info.path)
      info.isFile = stat.isFile()
      info.sizeBytes = stat.size
      if (platform !== 'win32') {
        try {
          accessSync(info.path, constants.X_OK)
          info.executablePermission = true
        } catch {
          info.executablePermission = false
        }
      }
    }
  } catch (error) {
    info.resolutionStatus = 'failed'
    info.error = diagnosticText(error instanceof Error ? error.message : String(error))
  }
  return info
}
