import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)

export type CodexExecutablePlatform = 'win32' | 'darwin' | 'linux' | 'android' | NodeJS.Platform
export type CodexExecutableArch = 'x64' | 'arm64' | NodeJS.Architecture

export type CodexExecutableResolution = {
  executablePath: string
  pathDirs: string[]
}

export type CodexExecutableResolverOptions = {
  platform?: CodexExecutablePlatform
  arch?: CodexExecutableArch
  existsSync?: (filePath: string) => boolean
  isFile?: (filePath: string) => boolean
  readDirSync?: (dirPath: string) => string[]
  resolveModule?: (id: string) => string
  createRequireFromPath?: (filePath: string) => { resolve: (id: string) => string }
  searchRoots?: string[]
  toUnpackedPath?: (filePath: string) => string
}

type CodexTarget = {
  targetTriple: string
  packageName: string
}

const CODEX_TARGET_BY_PLATFORM_ARCH: Record<string, CodexTarget> = {
  'linux:x64': {
    targetTriple: 'x86_64-unknown-linux-musl',
    packageName: '@openai/codex-linux-x64'
  },
  'android:x64': {
    targetTriple: 'x86_64-unknown-linux-musl',
    packageName: '@openai/codex-linux-x64'
  },
  'linux:arm64': {
    targetTriple: 'aarch64-unknown-linux-musl',
    packageName: '@openai/codex-linux-arm64'
  },
  'android:arm64': {
    targetTriple: 'aarch64-unknown-linux-musl',
    packageName: '@openai/codex-linux-arm64'
  },
  'darwin:x64': {
    targetTriple: 'x86_64-apple-darwin',
    packageName: '@openai/codex-darwin-x64'
  },
  'darwin:arm64': {
    targetTriple: 'aarch64-apple-darwin',
    packageName: '@openai/codex-darwin-arm64'
  },
  'win32:x64': {
    targetTriple: 'x86_64-pc-windows-msvc',
    packageName: '@openai/codex-win32-x64'
  },
  'win32:arm64': {
    targetTriple: 'aarch64-pc-windows-msvc',
    packageName: '@openai/codex-win32-arm64'
  }
}

export function getCodexTarget(
  options: Pick<CodexExecutableResolverOptions, 'platform' | 'arch'> = {}
): CodexTarget | undefined {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  return CODEX_TARGET_BY_PLATFORM_ARCH[`${platform}:${arch}`]
}

export function resolveCodexExecutable(
  options: CodexExecutableResolverOptions = {}
): CodexExecutableResolution | undefined {
  const target = getCodexTarget(options)
  if (!target) {
    return undefined
  }

  const platform = options.platform ?? process.platform
  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex'
  const existsSync = options.existsSync ?? fs.existsSync
  const isFile = options.isFile ?? defaultIsFile
  const readDirSync = options.readDirSync ?? defaultReadDirSync
  const resolveModule = options.resolveModule ?? require_.resolve
  const createRequireFromPath = options.createRequireFromPath ?? ((filePath: string) => createRequire(filePath))
  const toUnpackedPath = options.toUnpackedPath ?? toAsarUnpackedPath

  const resolveFromPackageJsonPath = (packageJsonPath: string): CodexExecutableResolution | undefined => {
    const vendorRoot = path.join(path.dirname(packageJsonPath), 'vendor')
    return resolveNativePackage(vendorRoot, target.targetTriple, binaryName, existsSync, isFile, toUnpackedPath)
  }

  try {
    const packageJsonPath = resolveModule(`${target.packageName}/package.json`)
    const resolved = resolveFromPackageJsonPath(packageJsonPath)
    if (resolved) {
      return resolved
    }
  } catch {
    // The native package is often nested below @openai/codex when installed by pnpm.
  }

  try {
    const codexPackageJsonPath = resolveModule('@openai/codex/package.json')
    const codexRequire = createRequireFromPath(codexPackageJsonPath)
    const packageJsonPath = codexRequire.resolve(`${target.packageName}/package.json`)
    const resolved = resolveFromPackageJsonPath(packageJsonPath)
    if (resolved) {
      return resolved
    }
  } catch {
    // Let the SDK attempt auto-discovery when neither path resolves.
  }

  try {
    const sdkEntryPath = toFilePath(resolveModule('@openai/codex-sdk'))
    if (sdkEntryPath) {
      const sdkRequire = createRequireFromPath(sdkEntryPath)
      const codexPackageJsonPath = sdkRequire.resolve('@openai/codex/package.json')
      const codexRequire = createRequireFromPath(codexPackageJsonPath)
      const packageJsonPath = codexRequire.resolve(`${target.packageName}/package.json`)
      const resolved = resolveFromPackageJsonPath(packageJsonPath)
      if (resolved) {
        return resolved
      }
    }
  } catch {
    // The final search-root pass handles bundled environments with isolated dependencies.
  }

  for (const rootPath of getSearchRoots(options.searchRoots)) {
    const bundled = resolveNativePackage(
      path.join(rootPath, 'codex', 'vendor'),
      target.targetTriple,
      binaryName,
      existsSync,
      isFile,
      toUnpackedPath
    )
    if (bundled) {
      return bundled
    }

    const resolved = resolveFromNodeModulesRoot(
      rootPath,
      target,
      binaryName,
      existsSync,
      isFile,
      readDirSync,
      toUnpackedPath
    )
    if (resolved) {
      return resolved
    }
  }

  return undefined
}

export function resolveCodexExecutablePath(options: CodexExecutableResolverOptions = {}): string | undefined {
  return resolveCodexExecutable(options)?.executablePath
}

function resolveNativePackage(
  vendorRoot: string,
  targetTriple: string,
  binaryName: string,
  existsSync: (filePath: string) => boolean,
  isFile: (filePath: string) => boolean,
  toUnpackedPath: (filePath: string) => string
): CodexExecutableResolution | undefined {
  const packageRoot = path.join(vendorRoot, targetTriple)
  const packageBinaryPath = path.join(packageRoot, 'bin', binaryName)
  if (isFile(packageBinaryPath) && isFile(path.join(packageRoot, 'codex-package.json'))) {
    return {
      executablePath: toUnpackedPath(packageBinaryPath),
      pathDirs: existingDirs(path.join(packageRoot, 'codex-path'), existsSync).map(toUnpackedPath)
    }
  }

  const legacyBinaryPath = path.join(packageRoot, 'codex', binaryName)
  if (isFile(legacyBinaryPath)) {
    return {
      executablePath: toUnpackedPath(legacyBinaryPath),
      pathDirs: existingDirs(path.join(packageRoot, 'path'), existsSync).map(toUnpackedPath)
    }
  }

  return undefined
}

function resolveFromNodeModulesRoot(
  rootPath: string,
  target: CodexTarget,
  binaryName: string,
  existsSync: (filePath: string) => boolean,
  isFile: (filePath: string) => boolean,
  readDirSync: (dirPath: string) => string[],
  toUnpackedPath: (filePath: string) => string
): CodexExecutableResolution | undefined {
  const nodeModulesDir = path.join(rootPath, 'node_modules')
  const packageJsonCandidates = [
    path.join(nodeModulesDir, ...target.packageName.split('/'), 'package.json'),
    path.join(nodeModulesDir, '@openai', 'codex', 'node_modules', ...target.packageName.split('/'), 'package.json')
  ]

  const pnpmDir = path.join(nodeModulesDir, '.pnpm')
  if (existsSync(pnpmDir)) {
    for (const entry of readDirSync(pnpmDir)) {
      if (!entry.startsWith('@openai+codex@')) {
        continue
      }

      packageJsonCandidates.push(
        path.join(pnpmDir, entry, 'node_modules', '@openai', scopedPackageBasename(target.packageName), 'package.json')
      )

      const platformSuffix = target.packageName.replace('@openai/codex-', '')
      if (entry.endsWith(`-${platformSuffix}`)) {
        packageJsonCandidates.push(path.join(pnpmDir, entry, 'node_modules', '@openai', 'codex', 'package.json'))
      }
    }
  }

  for (const packageJsonPath of packageJsonCandidates) {
    const vendorRoot = path.join(path.dirname(packageJsonPath), 'vendor')
    const resolved = resolveNativePackage(
      vendorRoot,
      target.targetTriple,
      binaryName,
      existsSync,
      isFile,
      toUnpackedPath
    )
    if (resolved) {
      return resolved
    }
  }

  return undefined
}

function scopedPackageBasename(packageName: string): string {
  return packageName.split('/').at(-1) ?? packageName
}

function getSearchRoots(searchRoots?: string[]): string[] {
  const roots = [
    ...(searchRoots ?? []),
    process.cwd(),
    ...ancestorDirs(toFilePath(import.meta.url)),
    ...resourceRoots()
  ].filter(Boolean)

  return [...new Set(roots)]
}

function ancestorDirs(filePath?: string): string[] {
  if (!filePath) {
    return []
  }

  const dirs: string[] = []
  let current = path.dirname(filePath)
  for (let depth = 0; depth < 8; depth += 1) {
    dirs.push(current)
    const parent = path.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return dirs
}

function resourceRoots(): string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (!resourcesPath) {
    return []
  }

  return [resourcesPath, path.join(resourcesPath, 'app'), path.join(resourcesPath, 'app.asar.unpacked')]
}

function existingDirs(dirPath: string, existsSync: (filePath: string) => boolean): string[] {
  return existsSync(dirPath) ? [dirPath] : []
}

function defaultIsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function defaultReadDirSync(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath)
  } catch {
    return []
  }
}

function toFilePath(resolvedPathOrUrl?: string): string | undefined {
  if (!resolvedPathOrUrl) {
    return undefined
  }

  return resolvedPathOrUrl.startsWith('file:') ? fileURLToPath(resolvedPathOrUrl) : resolvedPathOrUrl
}

function toAsarUnpackedPath(filePath: string): string {
  const asarSegment = `${path.sep}app.asar${path.sep}`
  if (filePath.includes(asarSegment)) {
    return filePath.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
  }

  const asarSuffix = `${path.sep}app.asar`
  if (filePath.endsWith(asarSuffix)) {
    return `${filePath}.unpacked`
  }

  return filePath
}
