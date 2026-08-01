import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import StreamZip from 'node-stream-zip'

import {
  MANAGED_PYTHON_PACKAGES,
  MANAGED_PYTHON_PROFILE_VERSION,
  MANAGED_PYTHON_VERSION,
  type ManagedPythonPackageId
} from './ManagedPythonConfig'

export const MANAGED_PYTHON_RUNTIME_FORMAT = 'zen-ai-python-runtime'
export const MANAGED_PYTHON_RUNTIME_SCHEMA_VERSION = 1
export const MANAGED_PYTHON_RUNTIME_MANIFEST = 'manifest.json'
export const MANAGED_PYTHON_INSTALLED_MANIFEST = '.zen-python-runtime.json'

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 50_000
const MAX_MANIFEST_BYTES = 1024 * 1024

export interface ManagedPythonRuntimeManifest {
  format: typeof MANAGED_PYTHON_RUNTIME_FORMAT
  schemaVersion: typeof MANAGED_PYTHON_RUNTIME_SCHEMA_VERSION
  profileVersion: string
  pythonVersion: string
  platform: 'win32' | 'darwin'
  arch: 'x64' | 'arm64'
  executablePath: string
  packages: ManagedPythonPackageId[]
  treeSha256: string
  fileCount: number
  totalBytes: number
  createdAt: string
}

export interface ExtractedManagedPythonRuntime {
  manifest: ManagedPythonRuntimeManifest
  runtimeDir: string
  executablePath: string
}

function normalizeArchivePath(entryName: string): string {
  if (!entryName || entryName.includes('\0') || entryName.includes('\\')) {
    throw new Error(`Invalid runtime package path: ${entryName}`)
  }

  const normalized = path.posix.normalize(entryName)
  const segments = normalized.split('/').filter(Boolean)
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    segments.includes('..')
  ) {
    throw new Error(`Unsafe runtime package path: ${entryName}`)
  }

  return normalized.replace(/\/$/, '')
}

function isSymbolicLink(entry: StreamZip.ZipEntry): boolean {
  const unixMode = (entry.attr >>> 16) & 0o170000
  return unixMode === 0o120000
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Runtime package manifest has an invalid ${field}`)
  }
}

export function validateManagedPythonRuntimeManifest(
  value: unknown,
  platform: NodeJS.Platform,
  arch: string
): ManagedPythonRuntimeManifest {
  if (!value || typeof value !== 'object') throw new Error('Runtime package manifest is invalid')

  const manifest = value as Partial<ManagedPythonRuntimeManifest>
  if (manifest.format !== MANAGED_PYTHON_RUNTIME_FORMAT) throw new Error('This is not a Zen AI Python runtime package')
  if (manifest.schemaVersion !== MANAGED_PYTHON_RUNTIME_SCHEMA_VERSION) {
    throw new Error(`Unsupported runtime package schema: ${manifest.schemaVersion ?? 'unknown'}`)
  }
  if (manifest.profileVersion !== MANAGED_PYTHON_PROFILE_VERSION) {
    throw new Error(
      `Runtime package profile ${manifest.profileVersion ?? 'unknown'} is incompatible with profile ${MANAGED_PYTHON_PROFILE_VERSION}`
    )
  }
  if (platform !== 'win32' && platform !== 'darwin') {
    throw new Error(`Zen AI managed Python is not supported on ${platform}`)
  }
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`Unsupported processor architecture: ${arch}`)
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error(
      `Runtime package targets ${manifest.platform ?? 'unknown'}-${manifest.arch ?? 'unknown'}, but this app requires ${platform}-${arch}`
    )
  }

  assertString(manifest.pythonVersion, 'pythonVersion')
  if (
    manifest.pythonVersion !== MANAGED_PYTHON_VERSION &&
    !manifest.pythonVersion.startsWith(`${MANAGED_PYTHON_VERSION}.`)
  ) {
    throw new Error(`Runtime package requires unsupported Python ${manifest.pythonVersion}`)
  }

  assertString(manifest.executablePath, 'executablePath')
  const executablePath = normalizeArchivePath(manifest.executablePath)
  if (!executablePath.startsWith('runtime/')) {
    throw new Error('Runtime package executable must be inside the runtime directory')
  }

  const expectedPackages = MANAGED_PYTHON_PACKAGES.map((entry) => entry.id).sort()
  const packages = Array.isArray(manifest.packages) ? [...manifest.packages].sort() : []
  if (
    packages.length !== expectedPackages.length ||
    packages.some((entry, index) => entry !== expectedPackages[index])
  ) {
    throw new Error('Runtime package does not contain the required Zen AI productivity package profile')
  }

  if (typeof manifest.treeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.treeSha256)) {
    throw new Error('Runtime package manifest has an invalid tree hash')
  }
  if (!Number.isSafeInteger(manifest.fileCount) || manifest.fileCount! <= 0) {
    throw new Error('Runtime package manifest has an invalid file count')
  }
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes! <= 0) {
    throw new Error('Runtime package manifest has an invalid total size')
  }
  assertString(manifest.createdAt, 'createdAt')

  return { ...manifest, executablePath } as ManagedPythonRuntimeManifest
}

async function collectFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await fsp.readdir(currentDir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Runtime package contains a symbolic link: ${entry.name}`)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(rootDir, entryPath)))
    } else if (entry.isFile()) {
      files.push(entryPath)
    }
  }

  return files
}

export async function calculateRuntimeTreeMetadata(
  runtimeDir: string
): Promise<{ treeSha256: string; fileCount: number; totalBytes: number }> {
  const files = await collectFiles(runtimeDir)
  files.sort((left, right) => {
    const leftPath = path.relative(runtimeDir, left).replaceAll(path.sep, '/')
    const rightPath = path.relative(runtimeDir, right).replaceAll(path.sep, '/')
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
  })

  const hash = createHash('sha256')
  let totalBytes = 0

  for (const filePath of files) {
    const relativePath = path.relative(runtimeDir, filePath).replaceAll(path.sep, '/')
    const stat = await fsp.stat(filePath)
    totalBytes += stat.size
    hash.update(relativePath)
    hash.update('\0')
    hash.update(String(stat.size))
    hash.update('\0')
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
    hash.update('\0')
  }

  return { treeSha256: hash.digest('hex'), fileCount: files.length, totalBytes }
}

export function getManagedPythonRuntimeAssetName(
  platform: NodeJS.Platform,
  arch: string,
  profileVersion = MANAGED_PYTHON_PROFILE_VERSION
): string {
  const platformLabel = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform
  return `Zen-AI-Python-Runtime-p${profileVersion}-${platformLabel}-${arch}.zip`
}

export async function extractManagedPythonRuntimePackage(
  packagePath: string,
  destinationDir: string,
  platform: NodeJS.Platform,
  arch: string
): Promise<ExtractedManagedPythonRuntime> {
  const archiveStat = await fsp.stat(packagePath)
  if (!archiveStat.isFile()) throw new Error('The selected runtime package is not a file')
  if (archiveStat.size > MAX_ARCHIVE_BYTES) throw new Error('The selected runtime package is too large')

  const zip = new StreamZip.async({ file: packagePath, storeEntries: true })
  try {
    const entries = await zip.entries()
    const entryList = Object.values(entries)
    if (entryList.length === 0 || entryList.length > MAX_ARCHIVE_ENTRIES) {
      throw new Error('Runtime package contains an invalid number of files')
    }

    let extractedBytes = 0
    for (const entry of entryList) {
      const entryName = normalizeArchivePath(entry.name)
      if (entry.encrypted) throw new Error(`Runtime package contains an encrypted file: ${entryName}`)
      if (isSymbolicLink(entry)) throw new Error(`Runtime package contains a symbolic link: ${entryName}`)
      if (entryName !== MANAGED_PYTHON_RUNTIME_MANIFEST && !entryName.startsWith('runtime/')) {
        throw new Error(`Unexpected file in runtime package: ${entryName}`)
      }
      extractedBytes += entry.size
      if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('Runtime package expands beyond the allowed size')
    }

    const manifestEntry = entries[MANAGED_PYTHON_RUNTIME_MANIFEST]
    if (!manifestEntry || manifestEntry.size > MAX_MANIFEST_BYTES) {
      throw new Error('Runtime package manifest is missing or too large')
    }
    const manifest = validateManagedPythonRuntimeManifest(
      JSON.parse((await zip.entryData(manifestEntry)).toString('utf8')),
      platform,
      arch
    )

    await fsp.mkdir(destinationDir, { recursive: true })
    const destinationRoot = path.resolve(destinationDir)
    for (const entry of entryList) {
      const entryName = normalizeArchivePath(entry.name)
      if (!entryName || entryName === MANAGED_PYTHON_RUNTIME_MANIFEST) continue
      const targetPath = path.resolve(destinationRoot, ...entryName.split('/'))
      if (targetPath !== destinationRoot && !targetPath.startsWith(`${destinationRoot}${path.sep}`)) {
        throw new Error(`Unsafe runtime package path: ${entry.name}`)
      }
      if (entry.isDirectory) {
        await fsp.mkdir(targetPath, { recursive: true })
        continue
      }

      await fsp.mkdir(path.dirname(targetPath), { recursive: true })
      const source = await zip.stream(entry)
      await pipeline(source, fs.createWriteStream(targetPath, { flags: 'wx' }))
    }

    const runtimeDir = path.join(destinationRoot, 'runtime')
    const metadata = await calculateRuntimeTreeMetadata(runtimeDir)
    if (
      metadata.treeSha256 !== manifest.treeSha256 ||
      metadata.fileCount !== manifest.fileCount ||
      metadata.totalBytes !== manifest.totalBytes
    ) {
      throw new Error('Runtime package integrity check failed')
    }

    const executableRelativePath = path.posix.relative('runtime', manifest.executablePath)
    const executablePath = path.resolve(runtimeDir, ...executableRelativePath.split('/'))
    if (!executablePath.startsWith(`${path.resolve(runtimeDir)}${path.sep}`) || !fs.existsSync(executablePath)) {
      throw new Error('Runtime package Python executable is missing')
    }
    if (platform !== 'win32') await fsp.chmod(executablePath, 0o755)

    return { manifest, runtimeDir, executablePath }
  } finally {
    await zip.close()
  }
}
