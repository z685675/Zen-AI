import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readdir } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { HOTPATCH_LIMITS, type HotpatchArtifact, HotpatchError } from '@shared/hotpatch'
import StreamZip from 'node-stream-zip'

import { readSnapshotFile, safeSnapshotPath } from './resources'

async function preflightCentralDirectory(filename: string, files: number): Promise<void> {
  const handle = await open(filename, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 22 || stat.size > HOTPATCH_LIMITS.archiveBytes)
      throw new HotpatchError('archive', 'Invalid ZIP size/type')
    const length = Math.min(stat.size, 65557),
      tail = Buffer.alloc(length)
    const { bytesRead } = await handle.read(tail, 0, length, stat.size - length)
    if (bytesRead !== length) throw new HotpatchError('archive', 'Truncated ZIP directory')
    for (let offset = length - 22; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) !== 0x06054b50 || offset + 22 + tail.readUInt16LE(offset + 20) !== length) continue
      const disk = tail.readUInt16LE(offset + 4),
        startDisk = tail.readUInt16LE(offset + 6)
      const onDisk = tail.readUInt16LE(offset + 8),
        count = tail.readUInt16LE(offset + 10)
      const size = tail.readUInt32LE(offset + 12),
        start = tail.readUInt32LE(offset + 16)
      // Our bounded, <512 MiB / 10000-file snapshots never require split archives or ZIP64.
      if (
        disk ||
        startDisk ||
        count !== files ||
        onDisk !== count ||
        count > HOTPATCH_LIMITS.fileCount ||
        size > count * 4096 + 1024 ||
        start + size !== stat.size - length + offset
      )
        throw new HotpatchError('archive', 'ZIP directory exceeds its signed entry bounds')
      return
    }
    throw new HotpatchError('archive', 'Missing bounded ZIP directory')
  } finally {
    await handle.close()
  }
}

/** No library extract(): only newly created regular files from the signed allowlist. */
export async function extractSnapshot(
  archivePath: string,
  emptyDestination: string,
  artifact: HotpatchArtifact,
  signal: AbortSignal
): Promise<void> {
  if ((await lstat(emptyDestination)).isSymbolicLink() || (await readdir(emptyDestination)).length)
    throw new HotpatchError('path', 'Extraction directory must be an empty real directory')
  await preflightCentralDirectory(archivePath, artifact.files.length)
  const zip = new StreamZip.async({ file: archivePath, storeEntries: true })
  try {
    const entries = Object.values(await zip.entries())
    if (
      entries.length !== (await zip.entriesCount) ||
      entries.length !== artifact.files.length ||
      entries.length > HOTPATCH_LIMITS.fileCount
    )
      throw new HotpatchError('archive', 'Duplicate or unexpected archive entries')
    const expected = new Map(artifact.files.map((file) => [file.path, file]))
    const folded = new Set<string>()
    let declared = 0
    for (const entry of entries) {
      const file = expected.get(entry.name)
      const kind = (entry.attr >>> 16) & 0xf000
      if (
        !file ||
        !safeSnapshotPath(entry.name) ||
        entry.isDirectory ||
        entry.attr & 0x10 ||
        ![0, 0x8000].includes(kind) ||
        entry.flags & 1 ||
        ![0, 8].includes(entry.method) ||
        entry.size !== file.size ||
        entry.compressedSize > HOTPATCH_LIMITS.archiveBytes ||
        folded.has(entry.name.toLowerCase())
      )
        throw new HotpatchError('archive', 'Unsafe or mismatched archive entry')
      folded.add(entry.name.toLowerCase())
      declared += entry.size
      if (declared > HOTPATCH_LIMITS.expandedBytes)
        throw new HotpatchError('size', 'Archive expanded size exceeds limit')
    }
    if (declared !== artifact.expandedSize) throw new HotpatchError('size', 'Archive expanded size mismatch')
    let actual = 0
    for (const entry of entries) {
      signal.throwIfAborted()
      const file = expected.get(entry.name)!
      const output = path.join(emptyDestination, ...entry.name.split('/'))
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
      let size = 0
      const hash = createHash('sha256')
      const bound = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length
          actual += chunk.length
          if (size > file.size || actual > artifact.expandedSize)
            return callback(new HotpatchError('size', 'Archive stream exceeded signed size'))
          hash.update(chunk)
          callback(null, chunk)
        }
      })
      await pipeline(await zip.stream(entry), bound, createWriteStream(output, { flags: 'wx', mode: 0o600 }), {
        signal
      })
      if (size !== file.size || hash.digest('hex') !== file.sha256)
        throw new HotpatchError('integrity', 'Extracted file hash mismatch')
    }
    if (actual !== artifact.expandedSize) throw new HotpatchError('integrity', 'Extracted snapshot is incomplete')
  } catch (error) {
    if (error instanceof HotpatchError || signal.aborted) throw error
    throw new HotpatchError('archive', 'Invalid or truncated ZIP archive')
  } finally {
    await zip.close().catch(() => {})
  }
}

export async function verifySnapshot(root: string, artifact: HotpatchArtifact): Promise<void> {
  const expected = new Set(artifact.files.map((file) => file.path))
  const directories = new Set<string>()
  for (const file of artifact.files) {
    const parts = file.path.split('/')
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'))
  }
  const visit = async (directory: string, prefix: string) => {
    const stat = await lstat(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new HotpatchError('path', 'Invalid snapshot directory')
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${item.name}` : item.name
      if (!safeSnapshotPath(name) || item.isSymbolicLink())
        throw new HotpatchError('path', 'Snapshot link/path rejected')
      if (item.isDirectory()) {
        if (!directories.has(name)) throw new HotpatchError('integrity', 'Unlisted snapshot directory')
        await visit(path.join(directory, item.name), name)
      } else if (!expected.delete(name)) throw new HotpatchError('integrity', 'Unlisted snapshot resource')
    }
  }
  await visit(root, '')
  if (expected.size) throw new HotpatchError('integrity', 'Missing snapshot resource')
  // Bounded concurrency avoids exhausting descriptors or allocating every resource at once.
  let index = 0
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (index < artifact.files.length) {
        const file = artifact.files[index++]
        try {
          await readSnapshotFile(root, file)
        } catch {
          throw new HotpatchError('integrity', 'Stored snapshot failed revalidation')
        }
      }
    })
  )
}
